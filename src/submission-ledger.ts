import {
  resolveActivationLedgerHome,
  tryHomeFromAkRolesPath,
} from "./activation-ledger-topology.ts";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";

import {
  acceptedFacts,
  isTerminatingToolName,
  type AcceptedDetails,
  type TerminatingToolName,
} from "./package-contracts/terminating-tools.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { readSitianRecords, resolveSitianRecordPathInLedger, sitianReport, type RecordPointer } from "./sitian-facade.ts";
import type { TerminalRoleName, TerminalRoleOutcome } from "./public-cli/terminal.ts";
import { isCorrectableExecuteError } from "./submission-correctable-error.ts";
import { failOnInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export type SubmissionCall = { readonly id: string; readonly name: string };
export type SubmissionOutcomeKind = "correctable-rejection" | "audit-escalation" | "infrastructure";
/** Typed correctable-rejection codes — settlement residual precedence without re-judging 0041. */
export type CorrectableRejectionCode = "non-sole-round" | "non-terminate" | "typed-bounce";
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
  | { readonly type: "sealed"; readonly attemptId: string; readonly toolCallId: string; readonly accepted: unknown; readonly projection: Extract<TerminalRoleOutcome, { kind: "accepted" }> }
  | { readonly type: "post-seal-anomaly"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string };

/**
 * Admitted run identity for the ledger subject.
 * Prefer AK_ROLE_RUN_DIR via sole runDirectory→runId parser (public-CLI correlation);
 * otherwise session header id. Never a shared "unbound" bucket.
 * Session-path layout fallback omitted: bare Pi and public CLI both expose header id
 * when a session exists; missing both is infrastructure, not a third guess.
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

function attemptIdentity(context: HostContext, runId: string): string {
  return context.sessionManager.getHeader?.()?.id ?? context.sessionManager.getLeafId?.() ?? `${runId}:initial`;
}

function isAcceptedProjection(value: unknown): value is Extract<TerminalRoleOutcome, { kind: "accepted" }> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Extract<TerminalRoleOutcome, { kind: "accepted" }>>;
  return candidate.kind === "accepted" && typeof candidate.role === "string" && typeof candidate.status === "string" && typeof candidate.decisiveFacts === "object" && candidate.decisiveFacts !== null;
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

/** Settlement read seam: typed sealed projection only, never host session JSONL. */
export async function readSealedSubmission(
  cwd: string,
  runId: string,
  home?: string,
): Promise<SealedSubmissionProjection | undefined> {
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, home);
  for (let index = owned.length - 1; index >= 0; index -= 1) {
    const record = owned[index];
    if (record?.kind === "post-seal-anomaly") return undefined;
    if (record?.kind !== "sealed") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> | undefined;
    if (payload?.type === "sealed" && isAcceptedProjection(payload.projection)) return payload.projection;
  }
  return undefined;
}

/** Non-final audit-escalation projection written by the submission ledger. */
export async function readAuditEscalationSubmission(
  cwd: string,
  runId: string,
  home?: string,
): Promise<AuditEscalationSubmissionProjection | undefined> {
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, home);
  for (let index = owned.length - 1; index >= 0; index -= 1) {
    const record = owned[index];
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
  home?: string,
): Promise<LatestSubmissionOutcome | undefined> {
  const { owned } = await readOwnedSubmissionRecords(cwd, runId, home);
  for (let index = owned.length - 1; index >= 0; index -= 1) {
    const record = owned[index];
    if (record?.kind !== "outcome") continue;
    const payload = record.payload as Partial<LatestSubmissionOutcome> | undefined;
    if (payload?.type === "outcome" && typeof payload.outcome === "string") {
      return payload as LatestSubmissionOutcome;
    }
  }
  return undefined;
}

type LedgerState = { prior?: RecordPointer; sealed: boolean; sequence: number };

async function restoreState(cwd: string, runId: string, home?: string): Promise<LedgerState> {
  const { file, owned } = await readOwnedSubmissionRecords(cwd, runId, home);
  const last = owned.at(-1);
  return {
    ...(last === undefined ? {} : { prior: { identity: last.identity, recordFile: file, kind: last.kind, level: last.level } }),
    sealed: owned.some((record) => record.kind === "sealed"),
    sequence: owned.reduce((maximum, record) => {
      const payload = record.payload as Partial<SubmissionLedgerEvent> | undefined;
      return payload?.type === "candidate" && typeof payload.sequence === "number" ? Math.max(maximum, payload.sequence) : maximum;
    }, 0),
  };
}

/** Pipeline-owned sole-final state and durable projection. */
export function createSubmissionLedgerHost(
  host: RoleHost,
  outputTools: ReadonlyMap<string, TerminalRoleName>,
  failInfrastructure: (error: unknown, context: HostContext) => never = (error) => { throw error; },
  projectClosure: (projection: ClosedSubmissionProjection, context: HostContext) => void | Promise<void> = () => undefined,
  options?: { home?: string },
): RoleHost {
  const states = new Map<string, Promise<LedgerState>>();
  type PendingCandidate = { toolCallId: string; toolName: TerminatingToolName; role: TerminalRoleName; result: HostToolResult<unknown>; context: HostContext; auditProjection?: Extract<TerminalRoleOutcome, { kind: "audit_escalation" }> };
  const rounds = new Map<string, PendingCandidate[]>();
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
    // Home only — must match submissionRecordFile topology (cwd + runId hash under
    // ledger home). Do not pass sessionParent: that nests under the session dir and
    // breaks restoreState reads which resolve the hash path without sessionParent.
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

  host.on("tool_execution_start", async ({ toolCallId, toolName }, context) => {
    try {
      const runId = runIdentity(context);
      const attemptId = attemptIdentity(context, runId);
      const state = await stateFor(context, runId);
      if (state.sealed) appendFor(state, context, runId, attemptId, { type: "post-seal-anomaly", attemptId, toolCallId, toolName });
    } catch (error) {
      failInfrastructure(error, context);
    }
  });
  host.on("turn_end", async (event, context) => {
    try {
      const runId = runIdentity(context);
      const attemptId = attemptIdentity(context, runId);
      const candidates = rounds.get(attemptId);
      if (candidates === undefined) return;
      rounds.delete(attemptId);
      const state = await stateFor(context, runId);
      const calls = event.calls.map(({ toolCallId: id, toolName: name }) => ({ id, name }));
      appendFor(state, context, runId, attemptId, { type: "roundContext", attemptId, calls });
      const sole = calls.length === 1 && candidates.length === 1 && calls[0]?.id === candidates[0]?.toolCallId;
      if (!sole) {
        for (const candidate of candidates) appendFor(state, context, runId, attemptId, { type: "outcome", attemptId, toolCallId: candidate.toolCallId, outcome: "correctable-rejection", code: "non-sole-round" });
        if (host.deliverSubmissionRejection === undefined) {
          throw new Error("宿主未提供模型可见的交卷封驳接缝");
        }
        context.abort();
        await host.deliverSubmissionRejection({
          kind: "correctable-rejection",
          code: "non-sole-round",
          toolCallIds: candidates.map(({ toolCallId }) => toolCallId),
        });
        return;
      }
      const candidate = candidates[0]!;
      if (candidate.auditProjection !== undefined) {
        appendFor(state, context, runId, attemptId, { type: "outcome", attemptId, toolCallId: candidate.toolCallId, outcome: "audit-escalation", projection: candidate.auditProjection });
        await projectClosure(candidate.auditProjection, context);
        context.abort();
        return;
      }
      const details = typeof candidate.result.details === "object" && candidate.result.details !== null ? candidate.result.details as Record<string, unknown> : {};
      const status = acceptedFacts(candidate.toolName, details as AcceptedDetails).status;
      if (typeof status !== "string" || status.length === 0) throw new Error("提交账封账缺少 acceptedFacts.status");
      const projection: Extract<TerminalRoleOutcome, { kind: "accepted" }> = { kind: "accepted", role: candidate.role, status, decisiveFacts: details };
      appendFor(state, candidate.context, runId, attemptId, { type: "sealed", attemptId, toolCallId: candidate.toolCallId, accepted: candidate.result.details, projection });
      state.sealed = true;
      await projectClosure(projection, context);
      context.abort();
    } catch (error) {
      failInfrastructure(error, context);
    }
  });

  const facade: RoleHost = {
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
          if (state.sealed) throw new Error("提交账已封账");
          // #541 / #575: shared infra-declaration fail lives on the ledger seam,
          // before any role execute or sole-final work (one owner for every seat).
          failOnInfrastructureFailureDeclaration(
            params,
            {
              failInfrastructure(error, ctx) {
                failInfrastructure(error, ctx);
              },
            },
            context,
            toolCallId,
          );
          append({ type: "candidate", attemptId, toolCallId, toolName: tool.name, sequence: ++state.sequence });
          let result: HostToolResult<unknown>;
          try {
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
            } else {
              append({
                type: "outcome",
                attemptId,
                toolCallId,
                outcome: "infrastructure",
                diagnostic: error instanceof Error ? error.message : String(error),
              });
            }
            throw error;
          }
          if (isAuditEscalationProjection(result.details)) {
            const candidates = rounds.get(attemptId) ?? [];
            candidates.push({
              toolCallId,
              toolName: tool.name as TerminatingToolName,
              role,
              result,
              context,
              auditProjection: {
                kind: "audit_escalation",
                role,
                status: "audit_escalation",
                decisiveFacts: result.details as Record<string, unknown>,
              },
            });
            rounds.set(attemptId, candidates);
            return {
              content: [],
              details: { submissionDisposition: "pending-round-closure" },
            };
          }
          if (result.terminate !== true) {
            append({ type: "outcome", attemptId, toolCallId, outcome: "correctable-rejection", code: "non-terminate" });
            return result;
          }
          if (!isTerminatingToolName(tool.name)) {
            append({ type: "outcome", attemptId, toolCallId, outcome: "infrastructure", diagnostic: `non-terminating tool ${tool.name}` });
            throw new Error("提交账只受理终止工具");
          }
          const candidates = rounds.get(attemptId) ?? [];
          candidates.push({ toolCallId, toolName: tool.name, role, result, context });
          rounds.set(attemptId, candidates);
          return {
            content: [],
            details: { submissionDisposition: "pending-round-closure" },
          };
        },
      });
    },
  };
  return facade;
}
