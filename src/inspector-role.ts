import { Type } from "typebox";

import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export { INSPECTOR_OUTPUT_TOOL_NAME as INSPECTOR_OUTPUT_TOOL };

export const inspectorOutputSchema = withInfrastructureFailureDeclaration(openToolObject(Type.Object({
  status: Type.Unknown({ description: "pass | bounce — 取值形状指引，不作拒收依据" }),
  findings: Type.Unknown({ description: "随交卷留存的问题记录" }),
})));

export function projectInspectorReceipt(parameters: unknown) {
  return {
    content: [{ type: "text" as const, text: "给事中回执已受理" }],
    details: parameters,
    terminate: true as const,
  };
}
