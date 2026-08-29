import { basename } from "node:path";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";
import { readSitianRecords, resolveSitianRecordPath, sitianReport, type RecordPointer } from "./sitian-facade.ts";
import type { TerminalRoleName, TerminalRoleOutcome } from "./public-cli/terminal.ts";

export type SubmissionCall = { readonly id: string; readonly name: string };
export type SubmissionLedgerEvent =
  | { readonly type: "batchContext"; readonly attemptId: string; readonly batchId: string; readonly closed: boolean; readonly calls: readonly SubmissionCall[] }
  | { readonly type: "candidate"; readonly attemptId: string; readonly batchId: string; readonly toolCallId: string; readonly toolName: string; readonly sequence: number }
  | { readonly type: "outcome"; readonly attemptId: string; readonly toolCallId: string; readonly outcome: "correctable-rejection" | "audit-escalation" | "infrastructure"; readonly diagnostic?: string }
  | { readonly type: "sealed"; readonly attemptId: string; readonly toolCallId: string; readonly accepted: unknown; readonly projection: Extract<TerminalRoleOutcome, { kind: "accepted" }> }
  | { readonly type: "post-seal-anomaly"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string };

function runIdentity(): string {
  const directory = process.env.AK_ROLE_RUN_DIR;
  return directory === undefined ? "unbound" : basename(directory).split("@")[0] || "unbound";
}

function attemptIdentity(context: HostContext): string {
  return context.sessionManager.getHeader?.()?.id ?? context.sessionManager.getLeafId?.() ?? `${runIdentity()}:initial`;
}

function isAcceptedProjection(value: unknown): value is Extract<TerminalRoleOutcome, { kind: "accepted" }> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Extract<TerminalRoleOutcome, { kind: "accepted" }>>;
  return candidate.kind === "accepted" && typeof candidate.role === "string" && typeof candidate.status === "string" && typeof candidate.decisiveFacts === "object" && candidate.decisiveFacts !== null;
}

export type SealedSubmissionProjection = Extract<SubmissionLedgerEvent, { type: "sealed" }>["projection"];

/** Settlement read seam: typed sealed projection only, never host session JSONL. */
export async function readSealedSubmission(cwd: string, runId: string): Promise<SealedSubmissionProjection | undefined> {
  const file = resolveSitianRecordPath({ level: "event", kind: "sealed", subject: { runId }, cwd }).recordFile;
  const { records } = await readSitianRecords(file);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.kind !== "sealed" || typeof record.subject !== "object" || record.subject?.runId !== runId) continue;
    const payload = record.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> | undefined;
    if (payload?.type === "sealed" && isAcceptedProjection(payload.projection)) return payload.projection;
  }
  return undefined;
}

type LedgerState = { prior?: RecordPointer; sealed: boolean; sequence: number };

async function restoreState(cwd: string, runId: string): Promise<LedgerState> {
  const file = resolveSitianRecordPath({ level: "event", kind: "candidate", subject: { runId }, cwd }).recordFile;
  const { records } = await readSitianRecords(file);
  const owned = records.filter((record) => typeof record.subject === "object" && record.subject?.runId === runId);
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
          const runId = runIdentity();
          const attemptId = attemptIdentity(context);
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
            append({ type: "outcome", attemptId, toolCallId, outcome: "infrastructure", diagnostic: error instanceof Error ? error.message : String(error) });
            throw error;
          }
          if (isAuditEscalationProjection(result.details)) {
            append({ type: "outcome", attemptId, toolCallId, outcome: "audit-escalation" });
            return result;
          }
          if (result.terminate !== true) {
            append({ type: "outcome", attemptId, toolCallId, outcome: "correctable-rejection" });
            return result;
          }
          const details = typeof result.details === "object" && result.details !== null ? result.details as Record<string, unknown> : {};
          const status = typeof details.status === "string" ? details.status : typeof details.judgeStatus === "string" ? details.judgeStatus : "accepted";
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
