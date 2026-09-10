import {
  resolveActivationLedgerHome,
  tryHomeFromAkRolesPath,
} from "./activation-ledger-topology.ts";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";


import {
  isTerminatingToolName,
  type TerminatingToolName,
} from "./package-contracts/terminating-tools.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { readSitianRecords, resolveSitianRecordPathInLedger, sitianReport, type RecordPointer } from "./sitian-facade.ts";
import type { TerminalRoleName, TerminalRoleOutcome } from "./public-cli/terminal.ts";
import { isCorrectableExecuteError } from "./submission-correctable-error.ts";
import { failOnInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export type SubmissionCall = { readonly id: string; readonly name: string };
export type SubmissionOutcomeKind = "correctable-rejection" | "audit-escalation" | "infrastructure";
/** Typed correctable-rejection codes — bounce/reminder paths only (#836: no sole/non-terminate reject). */
export type CorrectableRejectionCode = "typed-bounce";
export type SubmissionLedgerEvent =
  | { readonly type: "roundContext"; readonly attemptId: string; readonly calls: readonly SubmissionCall[] }
  | { readonly type: "candidate"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string; readonly sequence: number }
  | {
      readonly type: "outcome";
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly outcome: SubmissionOutcomeKind;
      readonly diagnostic?: string;
      readonly code?: CorrectableRejectionCode;
      /** Present for audit-escalation so settlement can project without JSONL rebuild. */
      readonly projection?: Extract<TerminalRoleOutcome, { kind: "audit_escalation" }>;
    }
  | {
      readonly type: "sealed";
      readonly attemptId: string;
      readonly toolCallId: string;
      /** Role payload as submitted — never rewritten (#836). */
      readonly accepted: unknown;
      readonly projection: Extract<TerminalRoleOutcome, { kind: "accepted" }>;
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

/** Status leaf as the role wrote it — no allowlist, no invented defaults (#836). */
function statusFromRoleDetails(details: Record<string, unknown>): string {
  if (typeof details.status === "string") return details.status;
  if (typeof details.judgeStatus === "string") return details.judgeStatus;
  if (typeof details.countersignStatus === "string") return details.countersignStatus;
  return "";
}

/**
 * LLM tool-call arguments are the role payload (#836 bounce: 写进账本的必须是 LLM 说的话).
 * Non-object args are preserved under `submission` — never replaced with `{}`.
 */
function rolePayloadFromParams(params: unknown): Record<string, unknown> {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return { submission: params };
}

function isAcceptedProjection(value: unknown): value is Extract<TerminalRoleOutcome, { kind: "accepted" }> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Extract<TerminalRoleOutcome, { kind: "accepted" }>>;
  return (
    candidate.kind === "accepted" &&
    typeof candidate.role === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.decisiveFacts === "object" &&
    candidate.decisiveFacts !== null
  );
}

function isAuditEscalationTerminalProjection(
  value: unknown,
): value is Extract<TerminalRoleOutcome, { kind: "audit_escalation" }> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Extract<TerminalRoleOutcome, { kind: "audit_escalation" }>>;
  return (
    candidate.kind === "audit_escalation" &&
    typeof candidate.role === "string" &&
    candidate.status === "audit_escalation" &&
    typeof candidate.decisiveFacts === "object" &&
    candidate.decisiveFacts !== null
  );
}

export type SealedSubmissionProjection = Extract<SubmissionLedgerEvent, { type: "sealed" }>["projection"];
export type AuditEscalationSubmissionProjection = Extract<TerminalRoleOutcome, { kind: "audit_escalation" }>;
export type ClosedSubmissionProjection = SealedSubmissionProjection | AuditEscalationSubmissionProjection;

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
  /** When set, only this court attempt's ledger rows participate. */
  readonly attemptId?: string;
};

function resolveReadScope(
  homeOrScope?: string | SubmissionLedgerReadScope,
): SubmissionLedgerReadScope {
  if (homeOrScope === undefined) return {};
  if (typeof homeOrScope === "string") return { home: homeOrScope };
  return homeOrScope;
}

function recordAttemptId(record: { subject?: unknown; payload?: unknown }): string | undefined {
  if (typeof record.subject === "object" && record.subject !== null) {
    const fromSubject = (record.subject as { attemptId?: unknown }).attemptId;
    if (typeof fromSubject === "string" && fromSubject.length > 0) return fromSubject;
  }
  if (typeof record.payload === "object" && record.payload !== null) {
    const fromPayload = (record.payload as { attemptId?: unknown }).attemptId;
    if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  }
  return undefined;
}

function recordsForAttempt<T extends { subject?: unknown; payload?: unknown }>(
  owned: readonly T[],
  attemptId: string | undefined,
): readonly T[] {
  if (attemptId === undefined) return owned;
  return owned.filter((record) => recordAttemptId(record) === attemptId);
}

/**
 * Latest recorded submission projection for a run (or court attempt).
 * #836: recording only — multiple submissions are all kept; this returns the latest.
 * Name retained for settlement call sites; no seal barrier remains.
 */
export async function readSealedSubmission(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<SealedSubmissionProjection | undefined> {
  const scope = resolveReadScope(homeOrScope);
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope.home);
  const scoped = recordsForAttempt(owned, scope.attemptId);
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const record = scoped[index];
    if (record?.kind !== "sealed") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> | undefined;
    if (payload?.type === "sealed" && isAcceptedProjection(payload.projection)) return payload.projection;
  }
  return undefined;
}

/** All recorded submission projections in ledger order (#836 multi-submit). */
export async function readRecordedSubmissions(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<readonly SealedSubmissionProjection[]> {
  const scope = resolveReadScope(homeOrScope);
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope.home);
  const scoped = recordsForAttempt(owned, scope.attemptId);
  const out: SealedSubmissionProjection[] = [];
  for (const record of scoped) {
    if (record.kind !== "sealed") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> | undefined;
    if (payload?.type === "sealed" && isAcceptedProjection(payload.projection)) out.push(payload.projection);
  }
  return out;
}

/** Non-final audit-escalation projection written by the submission ledger. */
export async function readAuditEscalationSubmission(
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<AuditEscalationSubmissionProjection | undefined> {
  const scope = resolveReadScope(homeOrScope);
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope.home);
  const scoped = recordsForAttempt(owned, scope.attemptId);
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const record = scoped[index];
    if (record?.kind !== "outcome") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "outcome" }>> | undefined;
    if (payload?.type !== "outcome" || payload.outcome !== "audit-escalation") continue;
    if (isAuditEscalationTerminalProjection(payload.projection)) return payload.projection;
  }
  return undefined;
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
  projectClosure: (projection: ClosedSubmissionProjection, context: HostContext) => void | Promise<void> = () => undefined,
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
          append({ type: "candidate", attemptId, toolCallId, toolName: tool.name, sequence: ++state.sequence });
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
              });
              throw error;
            } else {
              append({
                type: "outcome",
                attemptId,
                toolCallId,
                outcome: "infrastructure",
                diagnostic: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          }
          // #836: ledger authority is the LLM tool-call params (角色原话), never result.details.
          // Machine facts on result.details stay on the tool-result face returned to the model.
          const rolePayload = rolePayloadFromParams(params);
          if (isAuditEscalationProjection(result.details) || isAuditEscalationProjection(params)) {
            const projection: Extract<TerminalRoleOutcome, { kind: "audit_escalation" }> = {
              kind: "audit_escalation",
              role,
              status: "audit_escalation",
              decisiveFacts: rolePayload,
            };
            append({
              type: "outcome",
              attemptId,
              toolCallId,
              outcome: "audit-escalation",
              projection,
            });
            await projectClosure(projection, context);
            return result;
          }
          // Non-terminating tool results pass through unchanged (no non-terminate reject).
          if (result.terminate !== true) {
            return result;
          }
          if (!isTerminatingToolName(tool.name)) {
            append({
              type: "outcome",
              attemptId,
              toolCallId,
              outcome: "infrastructure",
              diagnostic: `non-terminating tool ${tool.name}`,
            });
            throw new Error("提交账只受理终止工具");
          }
          // #836: record LLM params immediately; call N times → N rows; no abort.
          const projection: Extract<TerminalRoleOutcome, { kind: "accepted" }> = {
            kind: "accepted",
            role,
            status: statusFromRoleDetails(rolePayload),
            decisiveFacts: rolePayload,
          };
          append({
            type: "sealed",
            attemptId,
            toolCallId,
            accepted: params,
            projection,
          });
          await projectClosure(projection, context);
          // Return the role's own tool result — never rewrite details (#836 B1.3).
          return result;
        },
      });
    },
  };
}
