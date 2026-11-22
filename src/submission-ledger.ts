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
import type { TerminalRoleName } from "./public-cli/terminal.ts";
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
  /** Missing or unreadable disposition evidence for this receipt, not a whole-leg failure. */
  readonly dispositionFault?: LedgerFault;
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

export type LedgerFault = { diagnostic: string; cause: unknown };

/** File order is arrival order. An original without any subsequent ledger fact is still a draft. */
export async function readRecordedSubmissionRows(
  cwd: string, runId: string, homeOrScope: string | SubmissionLedgerReadScope = {},
) {
  const scope = typeof homeOrScope === "string" ? { home: homeOrScope } : homeOrScope;
  let parent = scope.sessionParent;
  if (parent === undefined) {
    const run = await findRunDirectoryById(scope.home, runId);
    if (run === undefined) return { rows: [], fault: undefined, malformed: undefined, lastCourt: undefined };
    parent = sessionFileOf(run);
  }
  const { recordFile, sessionDir } = resolveSitianRecordPathInLedger({ level: "event", kind: "candidate",
    subject: { runId }, cwd, sessionParent: parent }, resolveActivationLedgerHome(scope.home));
  const facts = new Map<string, Omit<RecordedSubmissionRow, "path" | "receipt">>();
  const publications = new Map<string, { round: string; index: number }>();
  // Choose the replay court by journal order, never by receipt number.
  let lastCourt: string | LedgerFault | undefined;
  let journal;
  let fault: LedgerFault | undefined;
  try { journal = await readSitianRecords(recordFile); }
  catch (cause) { fault = { diagnostic: `${recordFile}: ${errorText(cause)}`, cause }; }
  // A seal implies its original has arrived. Discover files after reading the
  // journal, then overlay its dispositions on these unjournalled candidates.
  let discoveryFault: LedgerFault | undefined;
  try {
    for (const receipt of legReceiptReferences(sessionDir)) facts.set(receipt, { kind: "candidate" });
  } catch (cause) {
    discoveryFault = { diagnostic: `${join(sessionDir, "receipts")}: ${errorText(cause)}`, cause };
  }
  const reasons = journal?.diagnostics.map(d => `line ${d.line}: ${d.error}`).join("; ");
  const malformed = reasons ? { diagnostic: `${recordFile}: ${reasons}`, cause: reasons } : undefined;
  const gap = journal?.lastGap ?? 0;
  let latestIndex = -1;
  for (const [index, { kind, subject, payload }] of (journal?.records ?? []).entries()) {
    if (!isRecord(subject) || subject.runId !== runId || !isRecord(payload) || typeof payload.receipt !== "string") continue;
    const { receipt } = payload;
    if (kind === "sealed") { latestIndex = index; lastCourt = subject.attemptId as string; }
    if (kind === PROGRESS_RECORD_KIND && typeof payload.round === "string") {
      // Binding can fill the round later; it doesn't make the original publication newer.
      publications.set(receipt, { round: payload.round, index: publications.get(receipt)?.index ?? index });
      if (!facts.get(receipt)?.attemptId && typeof subject.attemptId === "string") {
        facts.set(receipt, { kind: "candidate", attemptId: subject.attemptId, ...(malformed && { dispositionFault: malformed }) });
      }
    }
    const disposition = kind === "sealed" ? "accepted" : kind === "candidate" ? "candidate" : kind === "outcome" ? payload.outcome : undefined;
    if (disposition !== "accepted" && disposition !== "candidate" && disposition !== "infrastructure" && disposition !== "correctable-rejection") continue;
    facts.set(receipt, { kind: disposition, role: payload.role as TerminalRoleName, toolCallId: payload.toolCallId as string,
      ...(disposition === "candidate" && index < gap && malformed && { dispositionFault: malformed }), attemptId: subject.attemptId as string });
  }
  const rows = [...facts].sort(([a], [b]) => parseInt(basename(a)) - parseInt(basename(b))).map(([receipt, fact]) => {
    const published = publications.get(receipt);
    const round = published?.round;
    let dispositionFault = fact.dispositionFault;
    if (published && fact.kind !== "accepted") {
      const cause = `progress for ${receipt} without a corresponding sealed record`;
      dispositionFault = { cause: dispositionFault?.cause ?? cause, diagnostic: `${dispositionFault?.diagnostic ?? recordFile}: ${cause}` };
      if (published.index > latestIndex) { latestIndex = published.index; lastCourt = dispositionFault; }
    }
    return { ...fact, receipt, path: join(sessionDir, "receipts", basename(receipt)), ...(round && { round }), ...(dispositionFault && { dispositionFault }) };
  });
  if (malformed && gap > latestIndex && [...facts.values()].some(fact => fact.dispositionFault)) lastCourt = malformed;
  return { rows, recordFile, missing: journal?.missing, fault, discoveryFault, malformed, lastCourt: fault ?? lastCourt };
}

export function readReceipt({ path }: RecordedSubmissionRow): unknown {
  return JSON.parse(exactUtf8(readFileSync(path), "receipt"));
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
  readonly courtAttemptId?: string; readonly invocationScopeId?: string; readonly instruction?: string;
}): void {
  const { runDirectory, role, toolCallId, accepted, cwd } = options;
  const runId = runIdFromRunDirectory(runDirectory);
  if (runId === undefined) throw new Error("提交账需要已受理的 run 身份");
  const attemptId = options.courtAttemptId ?? options.invocationScopeId ?? `${runId}:initial`;
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
    const attemptId = courtAttemptIdFromHostContext(context) ?? context.invocationScopeId ?? context.sessionManager.getHeader?.()?.id
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
