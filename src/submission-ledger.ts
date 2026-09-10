import {
  resolveActivationLedgerHome,
  tryHomeFromAkRolesPath,
} from "./activation-ledger-topology.ts";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";


import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { readSitianRecords, resolveSitianRecordPathInLedger, sitianReport, type RecordPointer } from "./sitian-facade.ts";
import type { TerminalRoleName } from "./public-cli/terminal.ts";
import { isCorrectableExecuteError } from "./submission-correctable-error.ts";
import { failOnInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export type SubmissionCall = { readonly id: string; readonly name: string };
export type SubmissionOutcomeKind = "correctable-rejection" | "audit-escalation" | "infrastructure";
/** Typed correctable-rejection codes — bounce/reminder paths only (#836: no sole/non-terminate reject). */
export type CorrectableRejectionCode = "typed-bounce";
export type SubmissionLedgerEvent =
  | { readonly type: "roundContext"; readonly attemptId: string; readonly calls: readonly SubmissionCall[] }
  | {
      readonly type: "candidate";
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly sequence: number;
      /** LLM tool-call params at call time (#836 原话). */
      readonly params?: unknown;
    }
  | {
      readonly type: "outcome";
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly outcome: SubmissionOutcomeKind;
      readonly diagnostic?: string;
      readonly code?: CorrectableRejectionCode;
      /** Seat identity — machine fact beside the payload (ADR 0042). */
      readonly role?: TerminalRoleName;
      /** Raw LLM params — bounce/infra/audit still keep the original words (#836). */
      readonly accepted?: unknown;
    }
  | {
      readonly type: "sealed";
      readonly attemptId: string;
      readonly toolCallId: string;
      /** Seat identity — machine fact beside the payload (ADR 0042). */
      readonly role: TerminalRoleName;
      /** Role payload as submitted — never rewritten (#836). */
      readonly accepted: unknown;
    };

/**
 * Admitted run identity for the ledger subject.
 * Prefer AK_ROLE_RUN_DIR via sole runDirectory→runId parser (public-CLI correlation);
 * otherwise session header id. Never a shared "unbound" bucket.
 */
function runIdentity(context: HostContext): string {
  const directory = process.env.AK_ROLE_RUN_DIR;
  if (typeof directory === "string" && directory.length > 0) {
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
  const courtAttempt = process.env[COURT_ATTEMPT_ENV];
  if (typeof courtAttempt === "string" && courtAttempt.length > 0) return courtAttempt;
  return context.sessionManager.getHeader?.()?.id ?? context.sessionManager.getLeafId?.() ?? `${runId}:initial`;
}

/** One recorded role submission as stored — original payload plus host identity. */
export type RecordedSubmissionRow = {
  readonly role: TerminalRoleName;
  readonly kind: "accepted" | "audit-escalation";
  readonly accepted: unknown;
};

/** Closed-submission callback: original payload, no status/facts projection (#836). */
export type ClosedSubmission = {
  readonly role: TerminalRoleName;
  readonly kind: "accepted" | "audit_escalation";
  readonly accepted: unknown;
};

export type ClosedSubmissionProjection = ClosedSubmission;

function submissionRecordFile(cwd: string, runId: string, home?: string): string {
  const ledgerHome = resolveActivationLedgerHome(home);
  return resolveSitianRecordPathInLedger({
    level: "event",
    kind: "candidate",
    subject: { runId },
    cwd,
  }, ledgerHome).recordFile;
}

async function readOwnedSubmissionRecords(cwd: string, runId: string, home?: string) {
  const file = submissionRecordFile(cwd, runId, home);
  const { records } = await readSitianRecords(file);
  return {
    file,
    owned: records.filter((record) => typeof record.subject === "object" && record.subject !== null && (record.subject as { runId?: string }).runId === runId),
  };
}

/** Optional court-turn scope for settlement reads (#637). */
export type SubmissionLedgerReadScope = {
  readonly home?: string;
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

function recordsForAttempt<T extends { subject?: unknown; payload?: unknown }>(
  owned: readonly T[],
  attemptId: string | undefined,
): readonly T[] {
  // #836: courtAttempt is a recording tag for new courts, not a visibility gate.
  void attemptId;
  return owned;
}

function isTerminalRoleName(value: unknown): value is TerminalRoleName {
  return typeof value === "string" && value.length > 0;
}

function recordedRole(payload: { role?: unknown; projection?: { role?: unknown } }): TerminalRoleName | undefined {
  if (isTerminalRoleName(payload.role)) return payload.role;
  // Historical rows stored role only inside the deleted projection envelope.
  if (isTerminalRoleName(payload.projection?.role)) return payload.projection.role;
  return undefined;
}

/**
 * All recorded role submissions in ledger order (#836 multi-submit).
 * `accepted` is the original payload; never rebuilt from a status/facts envelope.
 */
export async function readRecordedSubmissionRows(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<readonly RecordedSubmissionRow[]> {
  const scope = resolveReadScope(homeOrScope);
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope.home);
  const scoped = recordsForAttempt(owned, scope.attemptId);
  const out: RecordedSubmissionRow[] = [];
  for (const record of scoped) {
    if (record.kind === "sealed") {
      const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> & {
        projection?: { role?: unknown };
      } | undefined;
      if (payload?.type !== "sealed" || payload.accepted === undefined) continue;
      const role = recordedRole(payload);
      if (role === undefined) continue;
      out.push({ role, kind: "accepted", accepted: payload.accepted });
      continue;
    }
    if (record.kind !== "outcome") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "outcome" }>> & {
      projection?: { role?: unknown };
    } | undefined;
    if (payload?.type !== "outcome" || payload.outcome !== "audit-escalation" || payload.accepted === undefined) {
      continue;
    }
    const role = recordedRole(payload);
    if (role === undefined) continue;
    out.push({ role, kind: "audit-escalation", accepted: payload.accepted });
  }
  return out;
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

/** True when the run has at least one recorded accepted or audit-escalation payload. */
export async function hasRecordedSubmission(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<boolean> {
  return (await readRecordedSubmissionRows(cwd, runId, homeOrScope)).length > 0;
}

export type LatestSubmissionOutcome = Extract<SubmissionLedgerEvent, { type: "outcome" }>;

/** Latest non-final outcome on the run ledger (settlement residual precedence). */
export async function readLatestSubmissionOutcome(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<LatestSubmissionOutcome | undefined> {
  const scope = resolveReadScope(homeOrScope);
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope.home);
  const scoped = recordsForAttempt(owned, scope.attemptId);
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const record = scoped[index];
    if (record?.kind !== "outcome") continue;
    const payload = record.payload as Partial<LatestSubmissionOutcome> | undefined;
    if (payload?.type === "outcome" && typeof payload.outcome === "string") {
      return payload as LatestSubmissionOutcome;
    }
  }
  return undefined;
}

type LedgerState = { prior?: RecordPointer; sequence: number };

async function restoreState(cwd: string, runId: string, home?: string): Promise<LedgerState> {
  const { file, owned } = await readOwnedSubmissionRecords(cwd, runId, home);
  const last = owned.at(-1);
  return {
    ...(last === undefined ? {} : { prior: { identity: last.identity, recordFile: file, kind: last.kind, level: last.level } }),
    sequence: owned.reduce((maximum, record) => {
      const payload = record.payload as Partial<SubmissionLedgerEvent> | undefined;
      return payload?.type === "candidate" && typeof payload.sequence === "number" ? Math.max(maximum, payload.sequence) : maximum;
    }, 0),
  };
}

/**
 * Submission ledger host — record only (#836).
 * Each terminating submission is appended with the role's original payload.
 * No sole-final, no seal barrier, no context.abort(), no details rewrite.
 * Host end (turn close / exit code) is the final; ledger contents are presented as-is.
 */
export function createSubmissionLedgerHost(
  host: RoleHost,
  outputTools: ReadonlyMap<string, TerminalRoleName>,
  failInfrastructure: (error: unknown, context: HostContext) => never = (error) => { throw error; },
  projectClosure: (closed: ClosedSubmission, context: HostContext) => void | Promise<void> = () => undefined,
  options?: { home?: string },
): RoleHost {
  const states = new Map<string, Promise<LedgerState>>();
  const resolveHomeFromContext = (context: HostContext): string | undefined => {
    if (options?.home !== undefined) return options.home;
    const sessionFile = context.sessionManager.getSessionFile?.() || context.sessionManager.getSessionDir?.();
    return typeof sessionFile === "string" && sessionFile.length > 0
      ? tryHomeFromAkRolesPath(sessionFile)
      : undefined;
  };
  const stateFor = (context: HostContext, runId: string) => states.get(runId) ?? (() => {
    const home = resolveHomeFromContext(context);
    const pending = restoreState(context.cwd, runId, home);
    states.set(runId, pending);
    return pending;
  })();
  const appendFor = (state: LedgerState, context: HostContext, runId: string, attemptId: string, event: SubmissionLedgerEvent): RecordPointer => {
    const home = resolveHomeFromContext(context);
    const pointer = sitianReport({
      level: "event",
      kind: event.type,
      subject: { runId, attemptId },
      ...(state.prior === undefined ? {} : { priorEventId: state.prior.identity }),
      payload: event,
      source: "role-runtime",
      cwd: context.cwd,
      ...(home !== undefined ? { home } : {}),
    });
    state.prior = pointer;
    return pointer;
  };

  host.on("turn_end", async (event, context) => {
    try {
      const runId = runIdentity(context);
      const attemptId = attemptIdentity(context, runId);
      const state = await stateFor(context, runId);
      const calls = event.calls.map(({ toolCallId: id, toolName: name }) => ({ id, name }));
      if (calls.length > 0) {
        appendFor(state, context, runId, attemptId, { type: "roundContext", attemptId, calls });
      }
    } catch (error) {
      failInfrastructure(error, context);
    }
  });

  return {
    ...host,
    registerTool(tool) {
      const role = outputTools.get(tool.name);
      if (role === undefined) return host.registerTool(tool);
      host.registerTool({
        ...tool,
        async execute(toolCallId, params, signal, update, context): Promise<HostToolResult<unknown>> {
          const runId = runIdentity(context);
          const attemptId = attemptIdentity(context, runId);
          const state = await stateFor(context, runId);
          const append = (event: SubmissionLedgerEvent) => appendFor(state, context, runId, attemptId, event);
          // #541 / #575: shared infra-declaration fail lives on the ledger seam.
          // #641 chain②: seats may bounce a misdeclared infrastructure failure
          // as correctable (2.1/2.2/2.3 keep paths).
          append({
            type: "candidate",
            attemptId,
            toolCallId,
            toolName: tool.name,
            sequence: ++state.sequence,
            params,
          });
          let result: HostToolResult<unknown>;
          try {
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
            result = await tool.execute(toolCallId, params, signal, update, context);
          } catch (error) {
            if (isCorrectableExecuteError(error)) {
              append({
                type: "outcome",
                attemptId,
                toolCallId,
                outcome: "correctable-rejection",
                code: "typed-bounce",
                diagnostic: error instanceof Error ? error.message : String(error),
                accepted: params,
              });
              throw error;
            } else {
              append({
                type: "outcome",
                attemptId,
                toolCallId,
                outcome: "infrastructure",
                diagnostic: error instanceof Error ? error.message : String(error),
                accepted: params,
              });
              throw error;
            }
          }
          // #836: ledger authority is the LLM tool-call params as-is (角色原话), never result.details.
          // Machine facts on result.details stay on the tool-result face returned to the model.
          if (isAuditEscalationProjection(result.details) || isAuditEscalationProjection(params)) {
            const closed: ClosedSubmission = {
              role,
              kind: "audit_escalation",
              accepted: params,
            };
            append({
              type: "outcome",
              attemptId,
              toolCallId,
              outcome: "audit-escalation",
              role,
              accepted: params,
            });
            await projectClosure(closed, context);
            return result;
          }
          // Terminating-tool wrap records every call; terminate flag does not withhold params.
          const closed: ClosedSubmission = {
            role,
            kind: "accepted",
            accepted: params,
          };
          append({
            type: "sealed",
            attemptId,
            toolCallId,
            role,
            accepted: params,
          });
          await projectClosure(closed, context);
          return result;
        },
      });
    },
  };
}
