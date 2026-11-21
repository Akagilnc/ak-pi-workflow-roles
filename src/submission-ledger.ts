import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { exactUtf8 } from "./exact-utf8.ts";
import { isUnboundRunDirectory, sessionFileIn, sessionFileOf } from "./role-run-placement.ts";
import { readPackageMaterial } from "./session-opening-materials.ts";
import { resolveActivationLedgerHome, tryHomeFromAkRolesPath } from "./activation-ledger-topology.ts";
import {
  courtAttemptIdFromHostContext, runDirectoryFromHostContext,
  type HostContext, type HostToolResult, type RoleHost,
} from "./host-contracts.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { readSitianRecords, resolveSitianRecordPathInLedger, sitianReport } from "./sitian-facade.ts";
import { PROGRESS_RECORD_KIND } from "./run-dossier-files.ts";
import { findRunDirectoryById } from "./public-cli/run-lifecycle.ts";
import type { TerminalResult, TerminalRoleName } from "./public-cli/terminal.ts";
import { isCorrectableExecuteError } from "./submission-correctable-error.ts";
import { reportTicketFromHostContext } from "./report-ticket-tool.ts";
import { readDeclaredTicketNumber } from "./run-ticket-number.ts";
import { captureWorktreeHead, landTicketProgress, landTicketProgressForSealedSubmission, legReceiptReferences, writeArrivingReceipt } from "./ticket-progress.ts";
import { isRecord, errorText } from "./unknown-value.ts";

export const COURT_ATTEMPT_ENV = "AK_ROLE_COURT_ATTEMPT" as const;

type SubmissionKind = "accepted" | "correctable-rejection" | "infrastructure" | "candidate";
export type RecordedSubmissionRow = {
  readonly role?: TerminalRoleName;
  readonly kind: SubmissionKind;
  readonly path: string;
  readonly toolCallId?: string;
  readonly receipt: string;
  readonly round?: string;
  readonly attemptId?: string;
};
export type ClosedSubmission = {
  readonly role: TerminalRoleName;
  readonly kind: "accepted" | "audit_escalation";
  readonly accepted: unknown;
};

export type SubmissionLedgerReadScope = {
  readonly home?: string;
  readonly sessionParent?: string;
};

export class ReceiptReadError extends Error {
  constructor(readonly receipt: string, cause: unknown, readonly history?: Pick<TerminalResult, "submissions" | "receiptErrors">) {
    super(`${receipt}: ${errorText(cause)}`, { cause });
  }
}

/** File order is arrival order. An original without any subsequent ledger fact is still a draft. */
export async function readRecordedSubmissionRows(
  cwd: string, runId: string, homeOrScope: string | SubmissionLedgerReadScope = {},
): Promise<readonly RecordedSubmissionRow[]> {
  const scope = typeof homeOrScope === "string" ? { home: homeOrScope } : homeOrScope;
  let parent = scope.sessionParent;
  if (parent === undefined) {
    const run = await findRunDirectoryById(scope.home, runId);
    if (run === undefined) return [];
    parent = sessionFileOf(run);
  }
  const { recordFile, sessionDir } = resolveSitianRecordPathInLedger({ level: "event", kind: "candidate",
    subject: { runId }, cwd, sessionParent: parent }, resolveActivationLedgerHome(scope.home));
  const facts = new Map<string, Omit<RecordedSubmissionRow, "path" | "receipt">>();
  const rounds = new Map<string, string>();
  // Directory discovery recovers unjournalled arrivals. If listing fails, the
  // named originals can still be opened: diagnose discovery, not a false empty court.
  try {
    for (const receipt of legReceiptReferences(sessionDir)) facts.set(receipt, { kind: "candidate" });
  } catch (error) {
    process.stderr.write(`receipt directory listing failed: ${errorText(error)}\n`);
  }
  for (const { kind, subject, payload } of (await readSitianRecords(recordFile)).records) {
    if (!isRecord(subject) || subject.runId !== runId || !isRecord(payload) || typeof payload.receipt !== "string") continue;
    const { receipt } = payload;
    if (kind === PROGRESS_RECORD_KIND && typeof payload.round === "string" && payload.round !== "") {
      rounds.set(receipt, payload.round);
    }
    const disposition = kind === "sealed" ? "accepted" : kind === "candidate" ? "candidate" : kind === "outcome" ? payload.outcome : undefined;
    if (disposition !== "accepted" && disposition !== "candidate" && disposition !== "infrastructure" && disposition !== "correctable-rejection") continue;
    facts.set(receipt, { kind: disposition, role: payload.role as TerminalRoleName, toolCallId: payload.toolCallId as string,
      attemptId: subject.attemptId as string });
  }
  return [...facts].sort(([a], [b]) => parseInt(basename(a)) - parseInt(basename(b))).map(([receipt, fact]) => {
    const round = rounds.get(receipt);
    return { ...fact, receipt, path: join(sessionDir, "receipts", basename(receipt)), ...(round === undefined ? {} : { round }) };
  });
}

export async function readSubmissionAttemptId(cwd: string, runId: string, toolCallId: string, scope?: SubmissionLedgerReadScope): Promise<string | undefined> {
  const rows = await readRecordedSubmissionRows(cwd, runId, scope);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "accepted" && row.toolCallId === toolCallId) return row.attemptId;
  }
  return undefined;
}

export function readReceipt({ path }: RecordedSubmissionRow): unknown {
  try { return JSON.parse(exactUtf8(readFileSync(path), "receipt")); }
  catch (error) { throw new ReceiptReadError(path, error); }
}

function runIdentity(context: HostContext): string {
  const directory = runDirectoryFromHostContext(context);
  const id = directory === undefined ? undefined : runIdFromRunDirectory(directory);
  const runId = id ?? context.sessionManager.getHeader?.()?.id;
  if (!runId) throw new Error("提交账需要已受理的 run 身份");
  return runId;
}

function sessionParentFromHostContext(context: HostContext): string | undefined {
  const directory = runDirectoryFromHostContext(context);
  if (directory !== undefined) return sessionFileOf(directory);
  const dir = context.sessionManager.getSessionDir?.();
  return context.sessionManager.getSessionFile?.() ?? (dir === undefined ? undefined : sessionFileIn(dir));
}

/** No-model navigator: the same original, seal fact and progress as a tool submission. */
export function sealAcceptedSubmission(options: {
  readonly runDirectory: string; readonly cwd: string; readonly role: TerminalRoleName;
  readonly accepted: unknown; readonly toolCallId: string; readonly home?: string;
  readonly courtAttemptId?: string; readonly instruction?: string;
}): void {
  const { runDirectory, role, toolCallId, accepted, cwd } = options;
  const runId = runIdFromRunDirectory(runDirectory);
  if (runId === undefined) throw new Error("提交账需要已受理的 run 身份");
  const attemptId = options.courtAttemptId ?? `${runId}:initial`;
  const receipt = writeArrivingReceipt(runDirectory, accepted);
  const sessionParent = sessionFileOf(runDirectory);
  sitianReport({ level: "event", kind: "sealed", subject: { runId, attemptId },
    payload: { type: "sealed", attemptId, toolCallId, role, receipt }, source: "role-runtime", cwd,
    home: options.home ?? tryHomeFromAkRolesPath(sessionParent), sessionParent });
  landTicketProgress({ runDirectory, role, receipt, accepted, sealHead: captureWorktreeHead(cwd),
    sessionFile: undefined, instruction: options.instruction ?? "", call: { attemptId, toolCallId } });
}

export function createSubmissionLedgerHost(
  host: RoleHost,
  outputTools: { get(toolName: string): TerminalRoleName | undefined },
  failInfrastructure: (error: unknown, context: HostContext, toolCallId?: string) => never = (error) => { throw error; },
  projectClosure: (closed: ClosedSubmission, context: HostContext, toolCallId: string) => void | Promise<void> = () => undefined,
  options?: { home?: string },
): RoleHost {
  function source(context: HostContext) {
    const runId = runIdentity(context);
    const attemptId = courtAttemptIdFromHostContext(context) ?? context.sessionManager.getHeader?.()?.id
      ?? context.sessionManager.getLeafId?.() ?? `${runId}:initial`;
    const sessionParent = sessionParentFromHostContext(context);
    const home = options?.home ?? (sessionParent === undefined ? undefined : tryHomeFromAkRolesPath(sessionParent));
    return { level: "event" as const, subject: { runId, attemptId }, source: "role-runtime", cwd: context.cwd,
      ...(sessionParent === undefined ? {} : { sessionParent }), ...(home === undefined ? {} : { home }) };
  }
  host.on("turn_end", async (event, context) => {
    try {
      const calls = event.calls.map(({ toolCallId: id, toolName: name }) => ({ id, name }));
      if (calls.length) {
        const origin = source(context);
        sitianReport({ ...origin, kind: "roundContext", payload: { type: "roundContext", attemptId: origin.subject.attemptId, calls } });
      }
    } catch (error) { failInfrastructure(error, context); }
  });
  return { ...host, registerTool(tool) {
    const role = outputTools.get(tool.name);
    if (role === undefined) return host.registerTool(tool);
    host.registerTool({ ...tool, async execute(toolCallId, params, signal, update, context) {
      let toolThrew = false;
      let result: HostToolResult<unknown>;
      try {
        const ticket = isRecord(params) ? readDeclaredTicketNumber(params.ticketNumber) : undefined;
        const origin = source(context);
        const { attemptId } = origin.subject;
        const { sessionDir } = resolveSitianRecordPathInLedger({ ...origin, kind: "candidate" }, resolveActivationLedgerHome(origin.home));
        const receipt = writeArrivingReceipt(sessionDir, params);
        const append = (type: string, extra: Record<string, unknown> = {}) => sitianReport({ ...source(context), subject: origin.subject, kind: type,
          payload: { type, attemptId, toolCallId, role, receipt, ...extra } });
        append("candidate", { toolName: tool.name });
        if (ticket !== undefined) await reportTicketFromHostContext(context, ticket);
        try { result = await tool.execute(toolCallId, params, signal, update, context); }
        catch (error) {
          append("outcome", { ...(isCorrectableExecuteError(error) ? { outcome: "correctable-rejection", code: "typed-bounce" } : { outcome: "infrastructure" }), diagnostic: errorText(error) });
          toolThrew = true;
          throw error;
        }
        if (result.terminate === false) return result;
        append("sealed");
        const lens = host.getFlag?.("ak-review-lens");
        landTicketProgressForSealedSubmission({ context, role, receipt, accepted: params, sealHead: captureWorktreeHead(context.cwd),
          ...(lens === "completeness" || lens === "correctness" ? { lens } : {}), call: { attemptId, toolCallId } });
        const directory = runDirectoryFromHostContext(context);
        if (context.host !== "claude" && context.host !== "codex" && directory !== undefined && isUnboundRunDirectory(directory)) {
          result = { ...result, terminate: false, content: [...result.content, {
            type: "text", text: (await readPackageMaterial("resources/ticket-at-receipt.md")).trim(),
          }] };
        }
      } catch (error) {
        if (toolThrew) throw error;
        return failInfrastructure(error, context, toolCallId);
      }
      await projectClosure({ role, kind: "accepted", accepted: params }, context, toolCallId);
      return result;
    } });
  } };
}
