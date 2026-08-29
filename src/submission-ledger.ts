import { basename } from "node:path";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";
import { GatekeeperDecisionError } from "./gatekeeper-role.ts";
import { AcceptedDetailsContractError } from "./package-contracts/terminating-tools.ts";
import { readSitianRecords, resolveSitianRecordPath, sitianReport, type RecordPointer } from "./sitian-facade.ts";
import type { TerminalRoleName, TerminalRoleOutcome } from "./public-cli/terminal.ts";
import {
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
} from "./worker-submission-gates.ts";

export type SubmissionCall = { readonly id: string; readonly name: string };
export type SubmissionOutcomeKind = "correctable-rejection" | "audit-escalation" | "infrastructure";
export type SubmissionLedgerEvent =
  | { readonly type: "batchContext"; readonly attemptId: string; readonly batchId: string; readonly closed: boolean; readonly calls: readonly SubmissionCall[] }
  | { readonly type: "candidate"; readonly attemptId: string; readonly batchId: string; readonly toolCallId: string; readonly toolName: string; readonly sequence: number }
  | {
      readonly type: "outcome";
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly outcome: SubmissionOutcomeKind;
      readonly diagnostic?: string;
      /** Present for audit-escalation so settlement can project without JSONL rebuild. */
      readonly projection?: Extract<TerminalRoleOutcome, { kind: "audit_escalation" }>;
    }
  | { readonly type: "sealed"; readonly attemptId: string; readonly toolCallId: string; readonly accepted: unknown; readonly projection: Extract<TerminalRoleOutcome, { kind: "accepted" }> }
  | { readonly type: "post-seal-anomaly"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string };

/** Typed bounce anchors owned by existing gates — never prose-classified. */
function isTypedCorrectableRejection(error: unknown): boolean {
  return (
    error instanceof GatekeeperDecisionError ||
    error instanceof WorkerUnfinishedReasonReminderError ||
    error instanceof WorkerCommitReminderError ||
    error instanceof WorkerPrefixReminderError ||
    error instanceof AcceptedDetailsContractError
  );
}

/**
 * Admitted run identity for the ledger subject.
 * Prefer AK_ROLE_RUN_DIR basename (public-CLI admitted.runId correlation);
 * otherwise session header / session-path segment. Never a shared "unbound" bucket.
 */
function runIdentity(context: HostContext): string {
  const directory = process.env.AK_ROLE_RUN_DIR;
  if (typeof directory === "string" && directory.length > 0) {
    const fromDir = basename(directory).split("@")[0];
    if (fromDir !== undefined && fromDir.length > 0) return fromDir;
  }
  const headerId = context.sessionManager.getHeader?.()?.id;
  if (typeof headerId === "string" && headerId.length > 0) return headerId;
  const sessionFile = context.sessionManager.getSessionFile?.();
  if (typeof sessionFile === "string" && sessionFile.length > 0) {
    const normalized = sessionFile.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const sessionIdx = segments.lastIndexOf("session");
    if (sessionIdx > 0) {
      const runSegment = segments[sessionIdx - 1];
      const fromPath = runSegment?.split("@")[0];
      if (fromPath !== undefined && fromPath.length > 0) return fromPath;
    }
  }
  throw new Error("submission ledger requires admitted run identity");
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

function submissionRecordFile(cwd: string, runId: string): string {
  return resolveSitianRecordPath({ level: "event", kind: "candidate", subject: { runId }, cwd }).recordFile;
}

async function readOwnedSubmissionRecords(cwd: string, runId: string) {
  const file = submissionRecordFile(cwd, runId);
  const { records } = await readSitianRecords(file);
  return {
    file,
    owned: records.filter((record) => typeof record.subject === "object" && record.subject?.runId === runId),
  };
}

/** Settlement read seam: typed sealed projection only, never host session JSONL. */
export async function readSealedSubmission(cwd: string, runId: string): Promise<SealedSubmissionProjection | undefined> {
  const { owned } = await readOwnedSubmissionRecords(cwd, runId);
  for (let index = owned.length - 1; index >= 0; index -= 1) {
    const record = owned[index];
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
): Promise<AuditEscalationSubmissionProjection | undefined> {
  const { owned } = await readOwnedSubmissionRecords(cwd, runId);
  for (let index = owned.length - 1; index >= 0; index -= 1) {
    const record = owned[index];
    if (record?.kind !== "outcome") continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "outcome" }>> | undefined;
    if (payload?.type !== "outcome" || payload.outcome !== "audit-escalation") continue;
    if (isAuditEscalationTerminalProjection(payload.projection)) return payload.projection;
  }
  return undefined;
}

type LedgerState = { prior?: RecordPointer; sealed: boolean; sequence: number };

async function restoreState(cwd: string, runId: string): Promise<LedgerState> {
  const { file, owned } = await readOwnedSubmissionRecords(cwd, runId);
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

function statusFromDetails(details: unknown, fallback: string): string {
  if (typeof details !== "object" || details === null) return fallback;
  const record = details as Record<string, unknown>;
  if (typeof record.status === "string") return record.status;
  if (typeof record.judgeStatus === "string") return record.judgeStatus;
  return fallback;
}

/** Pipeline-owned sole-final state and durable projection. */
export function createSubmissionLedgerHost(host: RoleHost, outputTools: ReadonlyMap<string, TerminalRoleName>): RoleHost {
  const states = new Map<string, Promise<LedgerState>>();
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
          const state = await (states.get(runId) ?? (() => { const pending = restoreState(context.cwd, runId); states.set(runId, pending); return pending; })());
          const append = (event: SubmissionLedgerEvent): RecordPointer => {
            const pointer = sitianReport({ level: "event", kind: event.type, subject: { runId, attemptId }, ...(state.prior === undefined ? {} : { priorEventId: state.prior.identity }), payload: event, source: "role-runtime", cwd: context.cwd });
            state.prior = pointer;
            return pointer;
          };
          if (state.sealed) {
            append({ type: "post-seal-anomaly", attemptId, toolCallId, toolName: tool.name });
            throw new Error("submission ledger is already sealed");
          }
          const batch = context.terminationBatch;
          const batchId = `${attemptId}:${toolCallId}`;
          append({ type: "batchContext", attemptId, batchId, closed: batch?.batchClosed === true, calls: batch?.calls ?? [] });
          append({ type: "candidate", attemptId, batchId, toolCallId, toolName: tool.name, sequence: ++state.sequence });
          const matching = batch?.calls.filter((call) => call.id === toolCallId && call.name === tool.name) ?? [];
          if (batch?.batchClosed !== true || batch.calls.length !== 1 || matching.length !== 1) {
            append({ type: "outcome", attemptId, toolCallId, outcome: "correctable-rejection" });
            throw new Error("terminating output must be the sole matching call in a closed batch");
          }
          let result: HostToolResult<unknown>;
          try {
            result = await tool.execute(toolCallId, params, signal, update, context);
          } catch (error) {
            const outcome: SubmissionOutcomeKind = isTypedCorrectableRejection(error)
              ? "correctable-rejection"
              : "infrastructure";
            append({
              type: "outcome",
              attemptId,
              toolCallId,
              outcome,
              diagnostic: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          if (isAuditEscalationProjection(result.details)) {
            append({
              type: "outcome",
              attemptId,
              toolCallId,
              outcome: "audit-escalation",
              projection: {
                kind: "audit_escalation",
                role,
                status: "audit_escalation",
                decisiveFacts: result.details as Record<string, unknown>,
              },
            });
            return result;
          }
          if (result.terminate !== true) {
            append({ type: "outcome", attemptId, toolCallId, outcome: "correctable-rejection" });
            return result;
          }
          const details = typeof result.details === "object" && result.details !== null ? result.details as Record<string, unknown> : {};
          const status = statusFromDetails(details, "accepted");
          const projection: Extract<TerminalRoleOutcome, { kind: "accepted" }> = { kind: "accepted", role, status, decisiveFacts: details };
          try {
            append({ type: "sealed", attemptId, toolCallId, accepted: result.details, projection });
          } catch (error) {
            try { append({ type: "outcome", attemptId, toolCallId, outcome: "infrastructure", diagnostic: error instanceof Error ? error.message : String(error) }); } catch { /* original persistence failure remains authoritative */ }
            throw error;
          }
          state.sealed = true;
          return result;
        },
      });
    },
  };
}
