/**
 * Public Auditor (审刑院) role — filed-officer envelope (#675).
 */
import {
  AUDITOR_OUTPUT_TOOL_NAME,
} from "./package-contracts/auditor-output.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

export { AUDITOR_OUTPUT_TOOL_NAME };

export type AuditorRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

export const AUDITOR_TOOL_SPEC = roleSubmissionDeclaration("auditor");
