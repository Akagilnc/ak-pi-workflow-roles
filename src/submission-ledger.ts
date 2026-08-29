import { basename } from "node:path";
import type { HostContext, HostToolResult, RoleHost } from "./host-contracts.ts";
import { isAuditEscalationProjection } from "./audit-escalation.ts";
import { sitianReport, type RecordPointer } from "./sitian-facade.ts";

export type SubmissionLedgerEvent =
  | { readonly type: "candidate"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string; readonly batchClosed: boolean; readonly sequence: number }
  | { readonly type: "outcome"; readonly attemptId: string; readonly toolCallId: string; readonly outcome: "correctable-rejection" | "audit-escalation" | "infrastructure"; readonly reason?: string }
  | { readonly type: "sealed"; readonly attemptId: string; readonly toolCallId: string; readonly accepted: unknown }
  | { readonly type: "post-seal-anomaly"; readonly attemptId: string; readonly toolCallId: string; readonly toolName: string };

function identity(): { runId: string; attemptId: string } {
  const runDirectory = process.env.AK_ROLE_RUN_DIR;
  const runId = runDirectory === undefined ? "unbound" : basename(runDirectory).split("@")[0] || "unbound";
  return { runId, attemptId: runId };
}

/** Pipeline-owned sole-final state and durable projection. */
export function createSubmissionLedgerHost(host: RoleHost, outputTools: ReadonlySet<string>): RoleHost {
  let prior: RecordPointer | undefined;
  let sealed = false;
  let sequence = 0;
  const append = (context: HostContext, event: SubmissionLedgerEvent): RecordPointer => {
    const ids = identity();
    const pointer = sitianReport({
      level: "event",
      kind: `submission-${event.type}`,
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
      if (!outputTools.has(tool.name)) return host.registerTool(tool);
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
          append(context, { type: "sealed", attemptId: ids.attemptId, toolCallId, accepted: result.details });
          sealed = true;
          return result;
        },
      });
    },
  };
}
