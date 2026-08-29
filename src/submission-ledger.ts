import { basename } from "node:path";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";
import { readSitianRecords, resolveSitianRecordPath, sitianReport, type RecordPointer } from "./sitian-facade.ts";

export type SubmissionLedgerEvent =
  | { readonly type: "candidate"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string; readonly batchClosed: boolean; readonly sequence: number }
  | { readonly type: "outcome"; readonly attemptId: string; readonly toolCallId: string; readonly outcome: "correctable-rejection" | "audit-escalation" | "infrastructure"; readonly reason?: string }
  | { readonly type: "sealed"; readonly attemptId: string; readonly toolCallId: string; readonly accepted: unknown; readonly projection: { readonly kind: "accepted"; readonly role: string; readonly status?: string; readonly decisiveFacts: unknown } }
  | { readonly type: "post-seal-anomaly"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string };

function identity(): { runId: string; attemptId: string } {
  const runDirectory = process.env.AK_ROLE_RUN_DIR;
  const runId = runDirectory === undefined ? "unbound" : basename(runDirectory).split("@")[0] || "unbound";
  return { runId, attemptId: runId };
}

export type SealedSubmissionProjection = Extract<SubmissionLedgerEvent, { type: "sealed" }>["projection"];

/** Settlement read seam: typed sealed projection only, never host session JSONL. */
export async function readSealedSubmission(cwd: string, runId: string): Promise<SealedSubmissionProjection | undefined> {
  const recordFile = resolveSitianRecordPath({ level: "event", kind: "sealed", subject: { runId }, cwd }).recordFile;
  const { records } = await readSitianRecords(recordFile);
  const matches = records.filter((record) => {
    if (record.kind !== "sealed" || typeof record.payload !== "object" || record.payload === null) return false;
    return typeof record.subject === "object" && record.subject !== null && record.subject.runId === runId;
  });
  const payload = matches.at(-1)?.payload as Partial<Extract<SubmissionLedgerEvent, { type: "sealed" }>> | undefined;
  return payload?.type === "sealed" && payload.projection?.kind === "accepted" ? payload.projection : undefined;
}

/** Pipeline-owned sole-final state and durable projection. */
export function createSubmissionLedgerHost(host: RoleHost, outputTools: ReadonlyMap<string, string>): RoleHost {
  let prior: RecordPointer | undefined;
  let sealed = false;
  let sequence = 0;
  const append = (context: HostContext, event: SubmissionLedgerEvent): RecordPointer => {
    const ids = identity();
    const pointer = sitianReport({
      level: "event",
      kind: event.type,
      subject: ids,
      ...(prior === undefined ? {} : { priorEventId: prior.identity }),
      payload: event,
      source: "role-runtime",
      cwd: context.cwd,
    });
    prior = pointer;
    return pointer;
  };
  return {
    ...host,
    registerTool(tool) {
      const role = outputTools.get(tool.name);
      if (role === undefined) return host.registerTool(tool);
      host.registerTool({
        ...tool,
        async execute(toolCallId, params, signal, update, context): Promise<HostToolResult<unknown>> {
          const ids = identity();
          if (sealed) {
            append(context, { type: "post-seal-anomaly", attemptId: ids.attemptId, toolCallId, toolName: tool.name });
            throw new Error("submission ledger is already sealed");
          }
          const batch = context.terminationBatch;
          append(context, { type: "candidate", attemptId: ids.attemptId, toolCallId, toolName: tool.name, batchClosed: batch?.batchClosed === true, sequence: ++sequence });
          const matching = batch?.calls.filter((call) => call.id === toolCallId && call.name === tool.name) ?? [];
          if (batch?.batchClosed !== true || batch.calls.length !== 1 || matching.length !== 1) {
            append(context, { type: "outcome", attemptId: ids.attemptId, toolCallId, outcome: "correctable-rejection", reason: "termination batch is not one closed matching call" });
            throw new Error("terminating output must be the sole matching call in a closed batch");
          }
          let result: HostToolResult<unknown>;
          try {
            result = await tool.execute(toolCallId, params, signal, update, context);
          } catch (error) {
            append(context, { type: "outcome", attemptId: ids.attemptId, toolCallId, outcome: "correctable-rejection", reason: error instanceof Error ? error.message : String(error) });
            throw error;
          }
          if (isAuditEscalationProjection(result.details)) {
            append(context, { type: "outcome", attemptId: ids.attemptId, toolCallId, outcome: "audit-escalation" });
            return result;
          }
          if (result.terminate !== true) {
            append(context, { type: "outcome", attemptId: ids.attemptId, toolCallId, outcome: "correctable-rejection" });
            return result;
          }
          const details = result.details as Record<string, unknown> | null;
          const status = details !== null && typeof details === "object"
            ? typeof details.status === "string" ? details.status : typeof details.judgeStatus === "string" ? details.judgeStatus : undefined
            : undefined;
          append(context, { type: "sealed", attemptId: ids.attemptId, toolCallId, accepted: result.details, projection: { kind: "accepted", role, ...(status === undefined ? {} : { status }), decisiveFacts: result.details } });
          sealed = true;
          return result;
        },
      });
    },
  };
}
