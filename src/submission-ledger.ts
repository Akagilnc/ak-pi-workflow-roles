import { runDirectoryOfSessionFile, sessionFileIn, sessionFileOf } from "./role-run-placement.ts";

import {
  tryHomeFromAkRolesPath,
} from "./activation-ledger-topology.ts";
import {
  courtAttemptIdFromHostContext,
  runDirectoryFromHostContext,
  type HostContext,
  type HostToolResult,
  type RoleHost,
} from "./host-contracts.ts";

import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { appendHistoryRowSync, readHistoryRowsSync, readSectionSync, writeSectionSync } from "./run-dossier.ts";
import { findRunDirectoryById } from "./public-cli/run-lifecycle.ts";
import type { TerminalRoleName } from "./public-cli/terminal.ts";
import { isCorrectableExecuteError } from "./submission-correctable-error.ts";
import { failOnInfrastructureFailureDeclaration, infrastructureFailureDiagnostic } from "./package-contracts/terminating-infrastructure.ts";
import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "./review-submission.ts";

import { isRecord, errorText } from "./unknown-value.ts";

/**
 * The gate's disposition of one submission, as written on its history row.
 * `continuing`: the gate kept the turn open and did not accept it.
 */
export type SubmissionDisposition = "accepted" | "rejected" | "infrastructure" | "continuing";

/**
 * One `history.jsonl` submission line: the role's original params plus the
 * gate's disposition, written once when the gate has decided (#1161). The
 * system prompt and output schema are those the host delivered for this turn
 * (current.json `delivery` section), present only when the host recorded them.
 */
type SubmissionHistoryRow = {
  readonly type: "submission";
  /** 1-based count of submission rows in this run. */
  readonly attempt: number;
  readonly at: string;
  /** Court-turn recording tag (#637). */
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly role?: TerminalRoleName;
  /** Role params as submitted — never rewritten (#836). */
  readonly params: unknown;
  readonly disposition: SubmissionDisposition;
  readonly reason?: string;
  readonly systemPrompt?: unknown;
  readonly outputSchema?: unknown;
};

/**
 * Admitted run identity for the ledger subject.
 * Prefer AK_ROLE_RUN_DIR via sole runDirectory→runId parser (public-CLI correlation);
 * otherwise session header id. Never a shared "unbound" bucket.
 */
function runIdentity(context: HostContext): string {
  const directory = runDirectoryFromHostContext(context);
  if (directory !== undefined) {
    const fromDir = runIdFromRunDirectory(directory);
    if (fromDir !== undefined) return fromDir;
  }
  const headerId = context.sessionManager.getHeader?.()?.id;
  if (typeof headerId === "string" && headerId.length > 0) return headerId;
  throw new Error("提交账需要已受理的 run 身份");
}

/**
 * Court-turn attempt identity (#637 same-ticket re-summons).
 * Recording tag only — does not gate acceptance or block further submissions (#836).
 */
export const COURT_ATTEMPT_ENV = "AK_ROLE_COURT_ATTEMPT" as const;

function attemptIdentity(context: HostContext, runId: string): string {
  const courtAttempt = courtAttemptIdFromHostContext(context);
  if (courtAttempt !== undefined) return courtAttempt;
  return context.sessionManager.getHeader?.()?.id ?? context.sessionManager.getLeafId?.() ?? `${runId}:initial`;
}

/** One recorded role submission as stored — original payload plus host identity. */
export type RecordedSubmissionRow = {
  /**
   * Seat identity when known. Historical correctable/infrastructure rows may omit it;
   * payloads still project (#881). Terminal acceptance kind still requires a role match.
   */
  readonly role?: TerminalRoleName;
  /**
   * Recording class on the ledger. Terminal acceptance kind still only follows
   * `accepted` / `audit-escalation`; every class carries the original payload (#881).
   */
  readonly kind: "accepted" | "audit-escalation" | "correctable-rejection" | "infrastructure" | "candidate";
  readonly accepted: unknown;
  readonly auditReceipt?: unknown;
  readonly auditOfficer?: unknown;
  /** Present when the ledger row names the tool call — used to dedupe candidate+outcome. */
  readonly toolCallId?: string;
};

/** Closed-submission callback: original payload, no status/facts projection (#836). */
export type ClosedSubmission = {
  readonly role: TerminalRoleName;
  readonly kind: "accepted" | "audit_escalation";
  readonly accepted: unknown;
};

export type ClosedSubmissionProjection = ClosedSubmission;

/** Optional court-turn scope for settlement reads (#637). */
export type SubmissionLedgerReadScope = {
  readonly home?: string;
  /** Durable run principal; the direct ownership coordinate when already known. */
  readonly sessionParent?: string;
  /**
   * Recording tag for this court. Presentation of original payloads is run-scoped
   * (#836: attempt/latest must not hide already-recorded rows).
   */
  readonly attemptId?: string;
};

function resolveReadScope(
  homeOrScope?: string | SubmissionLedgerReadScope,
): SubmissionLedgerReadScope {
  if (homeOrScope === undefined) return {};
  if (typeof homeOrScope === "string") return { home: homeOrScope };
  return homeOrScope;
}

/**
 * The run's submission history rows. Unknown run (no sessionParent and no
 * discoverable directory) → [] at the read boundary.
 */
async function readSubmissionRows(
  runId: string,
  scope: SubmissionLedgerReadScope,
): Promise<readonly Record<string, unknown>[]> {
  const runDirectory = scope.sessionParent !== undefined
    ? runDirectoryOfSessionFile(scope.sessionParent)
    : scope.home === undefined ? undefined : await findRunDirectoryById(scope.home, runId);
  if (runDirectory === undefined) return [];
  return readHistoryRowsSync(runDirectory).filter((row) => row.type === "submission");
}

function isTerminalRoleName(value: unknown): value is TerminalRoleName {
  return typeof value === "string" && value.length > 0;
}

const ROW_KIND_BY_DISPOSITION: Readonly<Record<SubmissionDisposition, RecordedSubmissionRow["kind"]>> = {
  accepted: "accepted",
  rejected: "correctable-rejection",
  infrastructure: "infrastructure",
  continuing: "candidate",
};

/**
 * All recorded role submissions in history order (#836 multi-submit / #881):
 * every original payload — accepted, rejected, infrastructure, and a
 * continuing candidate — one row per submission call.
 * `accepted` is the original payload; never rebuilt from a status/facts envelope.
 */
function mapSubmissionRows(rows: readonly Record<string, unknown>[]): readonly RecordedSubmissionRow[] {
  const out: RecordedSubmissionRow[] = [];
  for (const row of rows) {
    const disposition = row.disposition as SubmissionDisposition;
    const kind = ROW_KIND_BY_DISPOSITION[disposition];
    if (kind === undefined || row.params === undefined) continue;
    out.push({
      ...(isTerminalRoleName(row.role) ? { role: row.role } : {}),
      kind,
      accepted: row.params,
      ...(typeof row.toolCallId === "string" && row.toolCallId.length > 0
        ? { toolCallId: row.toolCallId }
        : {}),
    });
  }
  return out;
}

/**
 * All recorded role submissions in ledger order (#836 multi-submit).
 * `accepted` is the original payload; never rebuilt from a status/facts envelope.
 * Presentation stays run-scoped: attemptId on the read scope is a recording tag,
 * not a visibility gate (#836).
 */
export async function readRecordedSubmissionRows(
  _cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<readonly RecordedSubmissionRow[]> {
  return mapSubmissionRows(await readSubmissionRows(runId, resolveReadScope(homeOrScope)));
}

/**
 * Settlement-only this-court rows (#879 return path).
 * Filters by attemptId for court-scoped roleOutcome; does not replace the
 * run-scoped presentation API above (#836 visibility gate stays pass-through).
 */
export async function readAttemptScopedSubmissionRows(
  _cwd: string,
  runId: string,
  attemptId: string,
  home?: string,
): Promise<readonly RecordedSubmissionRow[]> {
  if (attemptId.length === 0) return [];
  const rows = await readSubmissionRows(runId, home === undefined ? {} : { home });
  return mapSubmissionRows(rows.filter((row) => row.attemptId === attemptId));
}

/**
 * All raw role payloads in ledger order (#836 multi-submit).
 * Returns `accepted` bytes as stored — unknown, never re-wrapped.
 */
export async function readRecordedSubmissions(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<readonly unknown[]> {
  return (await readRecordedSubmissionRows(cwd, runId, homeOrScope)).map((row) => row.accepted);
}

type LedgerState = { sequence: number };

function restoreState(runDirectory: string): LedgerState {
  return {
    sequence: readHistoryRowsSync(runDirectory).reduce(
      (maximum, row) => row.type === "submission" && typeof row.attempt === "number"
        ? Math.max(maximum, row.attempt)
        : maximum,
      0,
    ),
  };
}

/** Sole HostContext-derived session parent for ledger restore/append (never process.env). */
function sessionParentFromHostContext(context: HostContext): string | undefined {
  const runDirectory = runDirectoryFromHostContext(context);
  if (runDirectory !== undefined) return sessionFileOf(runDirectory);
  const sessionFile = context.sessionManager.getSessionFile?.();
  if (typeof sessionFile === "string" && sessionFile.length > 0) return sessionFile;
  const sessionDir = context.sessionManager.getSessionDir?.();
  if (typeof sessionDir === "string" && sessionDir.length > 0) {
    return sessionFileIn(sessionDir);
  }
  return undefined;
}

/** The run directory this host context records into. */
function runDirectoryOfContext(context: HostContext): string {
  const direct = runDirectoryFromHostContext(context);
  if (direct !== undefined) return direct;
  const sessionParent = sessionParentFromHostContext(context);
  if (sessionParent !== undefined) return runDirectoryOfSessionFile(sessionParent);
  throw new Error("提交账需要已受理的 run 目录");
}

/**
 * Write one submission history row and refresh the latest-submission view in
 * current.json. `state.sequence` numbers the rows; the delivered system prompt
 * and schema ride on the row when the host recorded them.
 */
function recordSubmission(
  runDirectory: string,
  state: LedgerState,
  row: Omit<SubmissionHistoryRow, "type" | "attempt" | "at" | "systemPrompt" | "outputSchema">,
): void {
  const delivery = readSectionSync(runDirectory, "delivery");
  const full: SubmissionHistoryRow = {
    type: "submission",
    attempt: ++state.sequence,
    at: new Date().toISOString(),
    ...row,
    ...(delivery?.systemPrompt === undefined ? {} : { systemPrompt: delivery.systemPrompt }),
    ...(delivery?.outputSchema === undefined ? {} : { outputSchema: delivery.outputSchema }),
  };
  appendHistoryRowSync(runDirectory, { ...full });
  const { systemPrompt: _prompt, outputSchema: _schema, ...latest } = full;
  writeSectionSync(runDirectory, "submission", { ...readSectionSync(runDirectory, "submission"), latest });
}

/**
 * #959: seal one accepted submission without a model tool call.
 * Same history row shape as the terminating-tool wrap.
 * Used when a prose-exit seat (navigator) harvests the final assistant text.
 */
export async function sealAcceptedSubmission(options: {
  readonly context: HostContext;
  readonly role: TerminalRoleName;
  readonly accepted: unknown;
  readonly toolCallId: string;
  readonly home?: string;
}): Promise<void> {
  const runId = runIdentity(options.context);
  const attemptId = attemptIdentity(options.context, runId);
  const runDirectory = runDirectoryOfContext(options.context);
  recordSubmission(runDirectory, restoreState(runDirectory), {
    attemptId,
    toolCallId: options.toolCallId,
    toolName: "prose-exit",
    role: options.role,
    params: options.accepted,
    disposition: "accepted",
  });
}

/**
 * Submission ledger host — record only (#836).
 * Each submission is written once to history.jsonl with the role's original
 * payload and the gate's disposition.
 * No sole-final, no seal barrier, no context.abort(), no details rewrite.
 * Host end (turn close / exit code) is the final; history is presented as-is.
 */
export function createSubmissionLedgerHost(
  host: RoleHost,
  outputTools: ReadonlyMap<string, TerminalRoleName | readonly TerminalRoleName[]>,
  failInfrastructure: (error: unknown, context: HostContext) => never = (error) => { throw error; },
  projectClosure: (closed: ClosedSubmission, context: HostContext) => void | Promise<void> = () => undefined,
  _options?: { home?: string },
): RoleHost {
  const states = new Map<string, LedgerState>();
  const stateFor = (runDirectory: string): LedgerState => {
    let state = states.get(runDirectory);
    if (state === undefined) {
      state = restoreState(runDirectory);
      states.set(runDirectory, state);
    }
    return state;
  };

  return {
    ...host,
    registerTool(tool) {
      const registeredRole = outputTools.get(tool.name);
      let role: TerminalRoleName | undefined;
      if (typeof registeredRole === "string") {
        role = registeredRole;
      } else if (registeredRole !== undefined) {
        const activeRole = host.getFlag("ak-role");
        role = typeof activeRole === "string" && registeredRole.includes(activeRole as TerminalRoleName)
          ? activeRole as TerminalRoleName
          : undefined;
      }
      if (role === undefined) return host.registerTool(tool);
      host.registerTool({
        ...tool,
        async execute(toolCallId, params, signal, update, context): Promise<HostToolResult<unknown>> {
          const runId = runIdentity(context);
          const attemptId = attemptIdentity(context, runId);
          const runDirectory = runDirectoryOfContext(context);
          const state = stateFor(runDirectory);
          const record = (disposition: SubmissionDisposition, reason?: string): void =>
            recordSubmission(runDirectory, state, {
              attemptId,
              toolCallId,
              toolName: tool.name,
              role,
              params,
              disposition,
              ...(reason === undefined ? {} : { reason }),
            });
          let result: HostToolResult<unknown>;
          try {
            // #541 / #575: shared infra-declaration fail lives on the ledger seam.
            // #641 chain②: seats may bounce a misdeclared infrastructure failure
            // as correctable (2.1/2.2/2.3 keep paths).
            // A review escalate that carries the failure declaration is the
            // seat's own submission. Every other declaration stays on the
            // host-failure seam. Tool identity comes from the registry map.
            const reviewEscalate = tool.name === REVIEW_SUBMISSION_OUTPUT_TOOL_NAME
              && infrastructureFailureDiagnostic(params) !== undefined
              && isRecord(params)
              && (params as Record<string, unknown>).status === "escalate";
            if (!reviewEscalate) {
              failOnInfrastructureFailureDeclaration(
                params,
                {
                  failInfrastructure(error, ctx) {
                    failInfrastructure(error, ctx);
                  },
                },
                context,
                toolCallId,
                tool.bounceInfrastructureDeclaration,
              );
            }
            result = await tool.execute(toolCallId, params, signal, update, context);
          } catch (error) {
            record(isCorrectableExecuteError(error) ? "rejected" : "infrastructure", errorText(error));
            throw error;
          }
          // #836: ledger authority is the LLM tool-call params as-is (角色原话), never result.details.
          // Machine facts on result.details stay on the tool-result face returned to the model.
          // A continuing gate leaves the submission recorded but not accepted.
          if (result.terminate === false) {
            record("continuing");
            return result;
          }
          record("accepted");
          const closed: ClosedSubmission = {
            role,
            kind: "accepted",
            accepted: params,
          };
          await projectClosure(closed, context);
          return result;
        },
      });
    },
  };
}
