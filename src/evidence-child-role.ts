/**
 * Public Evidence-Child role — filed-officer envelope (#675).
 */
import {
  EVIDENCE_CHILD_ACCEPTED_TEXT,
  EVIDENCE_CHILD_OUTPUT_TOOL_NAME,
  evidenceChildOutputSchema,
} from "./package-contracts/evidence-child-output.ts";

export { EVIDENCE_CHILD_ACCEPTED_TEXT, EVIDENCE_CHILD_OUTPUT_TOOL_NAME };

export type EvidenceChildRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

export const EVIDENCE_CHILD_TOOL_SPEC = {
  name: EVIDENCE_CHILD_OUTPUT_TOOL_NAME,
  label: "取证输出",
  description: "提交取证报告。",
  promptSnippet: "提交取证报告",
  parameters: evidenceChildOutputSchema,
} as const;
