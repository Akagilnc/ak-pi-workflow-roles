import { join } from "node:path";

import {
  resolveActivationLedgerHome,
  tryHomeFromAkRolesPath,
} from "./activation-ledger-topology.ts";
import {
  courtAttemptIdFromHostContext,
  runDirectoryFromHostContext,
  type HostContext,
  type HostToolResult,
  type RoleHost,
} from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";


import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { readSitianRecords, resolveSitianRecordPathInLedger, sitianReport, type RecordPointer } from "./sitian-facade.ts";
import { findRunDirectoryById } from "./public-cli/run-lifecycle.ts";
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
      /** Seat identity — machine fact beside the payload (ADR 0042 / #881). */
      readonly role?: TerminalRoleName;
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

async function submissionRecordFile(cwd: string, runId: string, scope: SubmissionLedgerReadScope): Promise<string> {
  const ledgerHome = resolveActivationLedgerHome(scope.home);
  const discoveredRun = scope.sessionParent === undefined
    ? await findRunDirectoryById(scope.home, runId)
    : undefined;
  return resolveSitianRecordPathInLedger({
    level: "event",
    kind: "candidate",
    subject: { runId },
    cwd,
    ...(scope.sessionParent !== undefined
      ? { sessionParent: scope.sessionParent }
      : discoveredRun === undefined
        ? {}
        : { sessionParent: join(discoveredRun, "session", "session.jsonl") }),
  }, ledgerHome).recordFile;
}

async function readOwnedSubmissionRecords(cwd: string, runId: string, scope: SubmissionLedgerReadScope = {}) {
  const file = await submissionRecordFile(cwd, runId, scope);
  const { records } = await readSitianRecords(file);
  return {
    file,
    owned: records.filter((record) => typeof record.subject === "object" && record.subject !== null && (record.subject as { runId?: string }).runId === runId),
  };
}

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

function recordsForAttempt<T extends { subject?: unknown; payload?: unknown }>(
  owned: readonly T[],
  attemptId: string | undefined,
): readonly T[] {
  // #836: courtAttempt is a recording tag for new courts, not a visibility gate.
  void attemptId;
  return owned;
}

/** Recording tag a row was written under — subject first, historical payload fallback. */
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

/**
 * True when the given attemptId itself already produced a sealed or
 * audit-escalation submission (#836 r12 class 2). This is a separate
 * freshness signal, not a presentation filter — `recordsForAttempt` above
 * stays a pass-through so every original payload keeps presenting honestly
 * (#836: attemptId is a recording tag, not a visibility gate). Settlement
 * consumes this only to stop a prior attempt's stale acceptance from
 * outranking the current attempt's own real host-turn failure signal
 * (#637 original intent, restored narrowly).
 */
export async function hasFreshAttemptSubmission(
  cwd: string,
  runId: string,
  attemptId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<boolean> {
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, resolveReadScope(homeOrScope));
  return owned.some((record) => {
    if (recordAttemptId(record) !== attemptId) return false;
    if (record.kind === "sealed") return true;
    if (record.kind === "outcome") {
      const payload = record.payload as { type?: string; outcome?: string } | undefined;
      return payload?.type === "outcome" && payload.outcome === "audit-escalation";
    }
    return false;
  });
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

/** Prefer a more complete row for the same tool call without inventing a sole winner across calls. */
function rowRank(kind: RecordedSubmissionRow["kind"]): number {
  switch (kind) {
    case "accepted":
      return 4;
    case "audit-escalation":
      return 3;
    case "correctable-rejection":
    case "infrastructure":
      return 2;
    case "candidate":
      return 1;
  }
}

/**
 * Same-call identity for reader pairing only (#881 / #836).
 * attemptId is already on the record (subject/payload); bare toolCallId alone
 * collapses distinct court attempts that reused a host call id.
 */
function submissionCallKey(attemptId: string | undefined, toolCallId: string): string {
  return `${attemptId ?? ""}\0${toolCallId}`;
}

function rowFromPayload(
  kind: RecordedSubmissionRow["kind"],
  payload: {
    role?: unknown;
    projection?: { role?: unknown };
    accepted?: unknown;
    params?: unknown;
    toolCallId?: unknown;
  },
  accepted: unknown,
  roleFallback?: TerminalRoleName,
): RecordedSubmissionRow {
  const role = recordedRole(payload) ?? roleFallback;
  return {
    ...(role === undefined ? {} : { role }),
    kind,
    accepted,
    ...(typeof payload.toolCallId === "string" && payload.toolCallId.length > 0
      ? { toolCallId: payload.toolCallId }
      : {}),
  };
}

/**
 * All recorded role submissions in ledger order (#836 multi-submit / #881).
 * Projects every original payload — sealed, audit-escalation, correctable-rejection,
 * infrastructure, and bare candidate — without outcome-class filtering.
 * Same call (candidate + outcome both carrying params) appears once — keyed by
 * recorded attemptId + toolCallId so distinct court attempts stay distinct (#881).
 * `accepted` is the original payload; never rebuilt from a status/facts envelope.
 */
function mapOwnedToSubmissionRows(
  owned: readonly { kind?: unknown; subject?: unknown; payload?: unknown }[],
): readonly RecordedSubmissionRow[] {
  const scoped = owned;
  const out: RecordedSubmissionRow[] = [];
  const indexByCall = new Map<string, number>();
  // Recover seat identity for historical non-sealed rows that omitted role (#881).
  const roleByCall = new Map<string, TerminalRoleName>();
  for (const record of scoped) {
    const payload = record.payload as {
      toolCallId?: unknown;
      role?: unknown;
      projection?: { role?: unknown };
    } | undefined;
    if (typeof payload?.toolCallId !== "string" || payload.toolCallId.length === 0) continue;
    const role = recordedRole(payload);
    if (role !== undefined) {
      roleByCall.set(submissionCallKey(recordAttemptId(record), payload.toolCallId), role);
    }
  }

  const take = (row: RecordedSubmissionRow, callKey: string | undefined): void => {
    const toolCallId = row.toolCallId;
    if (toolCallId !== undefined && callKey !== undefined) {
      const existingIndex = indexByCall.get(callKey);
      if (existingIndex !== undefined) {
        const existing = out[existingIndex]!;
        if (rowRank(row.kind) >= rowRank(existing.kind)) {
          out[existingIndex] = {
            ...row,
            toolCallId,
            // Keep a previously recovered role when the upgraded row still omits it.
            ...(row.role === undefined && existing.role !== undefined ? { role: existing.role } : {}),
          };
        } else if (existing.role === undefined && row.role !== undefined) {
          out[existingIndex] = { ...existing, role: row.role };
        }
        return;
      }
      indexByCall.set(callKey, out.length);
    }
    out.push(row);
  };

  for (const record of scoped) {
    const attemptId = recordAttemptId(record);
    if (record.kind === "candidate") {
      const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "candidate" }>> & {
        projection?: { role?: unknown };
      } | undefined;
      if (payload?.type !== "candidate" || payload.params === undefined) continue;
      const callKey =
        typeof payload.toolCallId === "string"
          ? submissionCallKey(attemptId, payload.toolCallId)
          : undefined;
      const fallback = callKey !== undefined ? roleByCall.get(callKey) : undefined;
      take(rowFromPayload("candidate", payload, payload.params, fallback), callKey);
      continue;
    }
    if (record.kind === "sealed") {
      const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> & {
        projection?: { role?: unknown };
      } | undefined;
      if (payload?.type !== "sealed" || payload.accepted === undefined) continue;
      const callKey =
        typeof payload.toolCallId === "string"
          ? submissionCallKey(attemptId, payload.toolCallId)
          : undefined;
      const fallback = callKey !== undefined ? roleByCall.get(callKey) : undefined;
      take(rowFromPayload("accepted", payload, payload.accepted, fallback), callKey);
      continue;
    }
    if (record.kind !== "outcome") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "outcome" }>> & {
      projection?: { role?: unknown };
    } | undefined;
    if (payload?.type !== "outcome" || payload.accepted === undefined) continue;
    const outcome = payload.outcome;
    const kind: RecordedSubmissionRow["kind"] |
      undefined =
      outcome === "audit-escalation"
        ? "audit-escalation"
        : outcome === "correctable-rejection"
          ? "correctable-rejection"
          : outcome === "infrastructure"
            ? "infrastructure"
            : undefined;
    if (kind === undefined) continue;
    const callKey =
      typeof payload.toolCallId === "string"
        ? submissionCallKey(attemptId, payload.toolCallId)
        : undefined;
    const fallback = callKey !== undefined ? roleByCall.get(callKey) : undefined;
    take(rowFromPayload(kind, payload, payload.accepted, fallback), callKey);
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
  cwd: string,
  runId: string,
  homeOrScope?: string | SubmissionLedgerReadScope,
): Promise<readonly RecordedSubmissionRow[]> {
  const scope = resolveReadScope(homeOrScope);
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope);
  const scoped = recordsForAttempt(owned, scope.attemptId);
  return mapOwnedToSubmissionRows(scoped);
}

/**
 * Settlement-only this-court rows (#879 return path).
 * Filters by attemptId for court-scoped roleOutcome; does not replace the
 * run-scoped presentation API above (#836 visibility gate stays pass-through).
 */
export async function readAttemptScopedSubmissionRows(
  cwd: string,
  runId: string,
  attemptId: string,
  home?: string,
): Promise<readonly RecordedSubmissionRow[]> {
  if (attemptId.length === 0) return [];
  const { owned } = await readOwnedSubmissionRecords(
    cwd,
    runId,
    home === undefined ? {} : { home },
  );
  return mapOwnedToSubmissionRows(owned.filter((record) => recordAttemptId(record) === attemptId));
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

/** True when the run has at least one recorded original payload (any outcome class). */
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
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, scope);
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

async function restoreState(cwd: string, runId: string, scope: SubmissionLedgerReadScope): Promise<LedgerState> {
  const { file, owned } = await readOwnedSubmissionRecords(cwd, runId, scope);
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
    const sessionParent = context.sessionManager.getSessionFile?.() || context.sessionManager.getSessionDir?.();
    const pending = restoreState(context.cwd, runId, {
      ...(home === undefined ? {} : { home }),
      ...(typeof sessionParent === "string" && sessionParent.length > 0 ? { sessionParent } : {}),
    });
    states.set(runId, pending);
    return pending;
  })();
  const appendFor = (state: LedgerState, context: HostContext, runId: string, attemptId: string, event: SubmissionLedgerEvent): RecordPointer => {
    const home = resolveHomeFromContext(context);
    const runDirectory = process.env.AK_ROLE_RUN_DIR;
    const sessionParent = typeof runDirectory === "string" && runDirectory.length > 0
      ? join(runDirectory, "session", "session.jsonl")
      : context.sessionManager.getSessionFile?.() || context.sessionManager.getSessionDir?.();
    const pointer = sitianReport({
      level: "event",
      kind: event.type,
      subject: { runId, attemptId },
      ...(state.prior === undefined ? {} : { priorEventId: state.prior.identity }),
      payload: event,
      source: "role-runtime",
      cwd: context.cwd,
      sessionParent: context.sessionManager.getSessionFile(),
      ...(home !== undefined ? { home } : {}),
      ...(typeof sessionParent === "string" && sessionParent.length > 0 ? { sessionParent } : {}),
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
            role,
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
                role,
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
                role,
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
