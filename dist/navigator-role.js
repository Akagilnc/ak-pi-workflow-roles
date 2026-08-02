import {
  navigatorReceiptV1Schema,
  validateNavigatorReceiptV1
} from "./navigator-contracts.js";
import { navigatorEvidenceReadSchema } from "./navigator-evidence.js";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "./package-contracts/navigator-output.js";
const NAVIGATOR_EVIDENCE_TOOL_NAME = "ak_navigator_evidence_read";
const NAVIGATOR_SNAPSHOT_FLAG = {
  name: "ak-navigator-snapshot",
  definition: { description: "Path to one frozen Navigator v1 snapshot", type: "string" }
};
function singleton(toolCallId, ctx) {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("Navigator output must be the sole final tool call");
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== NAVIGATOR_OUTPUT_TOOL_NAME) throw new Error("Navigator output must be the sole final tool call");
}
function createNavigatorToolDefinitions(activeState) {
  return [
    {
      name: NAVIGATOR_EVIDENCE_TOOL_NAME,
      label: "Navigator Evidence",
      description: "Read one admitted frozen evidence item.",
      parameters: navigatorEvidenceReadSchema,
      async execute(_id, params) {
        const active = activeState();
        if (!active) throw new Error("Navigator not activated");
        const details = active.store.read(params.evidenceId, params.offset, params.limit);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      }
    },
    {
      name: NAVIGATOR_OUTPUT_TOOL_NAME,
      label: "Navigator Output",
      description: "Submit one typed advisory posture.",
      parameters: navigatorReceiptV1Schema,
      async execute(id, params, signal, _update, ctx) {
        const active = activeState();
        if (!active) throw new Error("Navigator not activated");
        singleton(id, ctx);
        const output = validateNavigatorReceiptV1(params, active.snapshot, active.store.readRecord());
        return {
          content: [{ type: "text", text: "Navigator output accepted" }],
          details: output,
          terminate: true
        };
      }
    }
  ];
}
export {
  NAVIGATOR_EVIDENCE_TOOL_NAME,
  NAVIGATOR_OUTPUT_TOOL_NAME,
  NAVIGATOR_SNAPSHOT_FLAG,
  createNavigatorToolDefinitions
};
