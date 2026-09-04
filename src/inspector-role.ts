import type { Static } from "typebox";
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import {
  INSPECTOR_ACCEPTED_TEXT,
  INSPECTOR_OUTPUT_TOOL_NAME,
  validateRecordedInspectorOutput,
  type InspectorOutput,
} from "./inspector-contracts.ts";

export {
  INSPECTOR_ACCEPTED_TEXT,
  INSPECTOR_OUTPUT_TOOL_NAME,
};
export { INSPECTOR_OUTPUT_TOOL_NAME as INSPECTOR_OUTPUT_TOOL };
export type { InspectorOutput };
export { validateRecordedInspectorOutput };

/** 察院事后察举交卷形状；形状指引，非 schema 闸。 */
export const inspectorOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "pass | bounce | escalate — 形状指引，非 schema 闸",
      }),
      findings: Type.Unknown({
        description: "随交卷留存的问题记录",
      }),
    }),
  ),
);

export type InspectorOutputParameters = Static<typeof inspectorOutputSchema>;

export type InspectorRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 */
export const INSPECTOR_TOOL_SPEC = {
  name: INSPECTOR_OUTPUT_TOOL_NAME,
  label: "察院输出",
  description: "察院终局回执，状态为 pass、bounce 或 escalate。",
  promptSnippet: "察院终局回执",
  parameters: inspectorOutputSchema,
} as const;
