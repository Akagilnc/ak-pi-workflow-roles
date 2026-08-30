import { Type } from "typebox";

import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import { openToolObject } from "./open-tool-schema.ts";

export { INSPECTOR_OUTPUT_TOOL_NAME as INSPECTOR_OUTPUT_TOOL };

export const inspectorOutputSchema = openToolObject(Type.Object({
  status: Type.Unknown({ description: "pass | bounce — 形状指引，非 schema 闸" }),
  findings: Type.Unknown({ description: "string[] findings，随 pass 或 bounce 留存" }),
}));

export function projectInspectorReceipt(parameters: unknown) {
  return {
    content: [{ type: "text" as const, text: "Inspector verdict accepted" }],
    details: parameters,
    terminate: true as const,
  };
}
