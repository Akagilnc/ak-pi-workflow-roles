/**
 * Public Auditor (审刑院) role — filed-officer envelope (#675).
 */
import {
  AUDITOR_OUTPUT_TOOL_NAME,
  auditorOutputSchema,
} from "./package-contracts/auditor-output.ts";

export { AUDITOR_OUTPUT_TOOL_NAME };

export type AuditorRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

export const AUDITOR_TOOL_SPEC = {
  name: AUDITOR_OUTPUT_TOOL_NAME,
  label: "审刑院输出",
  description: "审刑院终局回执，status 为 converged、continue 或 escalate。",
  promptSnippet: "审刑院终局回执",
  parameters: auditorOutputSchema,
} as const;
