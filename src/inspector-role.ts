import type { Static } from "typebox";
import { reviewSubmissionSchema } from "./review-submission.ts";
import {
  INSPECTOR_OUTPUT_TOOL_NAME,
  validateRecordedInspectorOutput,
  type InspectorOutput,
} from "./inspector-contracts.ts";

export {
  INSPECTOR_OUTPUT_TOOL_NAME,
};
export { INSPECTOR_OUTPUT_TOOL_NAME as INSPECTOR_OUTPUT_TOOL };
export type { InspectorOutput };
export { validateRecordedInspectorOutput };

/** 台院事后察举交卷形状；形状指引，非 schema 闸。 */
export const inspectorOutputSchema = reviewSubmissionSchema;

export type InspectorOutputParameters = Static<typeof inspectorOutputSchema>;

export type InspectorRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 */
export const INSPECTOR_TOOL_SPEC = {
  name: INSPECTOR_OUTPUT_TOOL_NAME,
  label: "台院输出",
  description: "台院终局回执，状态为 converged、continue 或 escalate。",
  promptSnippet: "台院终局回执",
  parameters: inspectorOutputSchema,
} as const;
