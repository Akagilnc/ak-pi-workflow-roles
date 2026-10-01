import type { Static } from "typebox";

import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  gleanerLeftOutputSchema,
  validateRecordedGleanerLeftOutput,
  type GleanerLeftOutput,
} from "./gleaner-left-contracts.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

export {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  gleanerLeftOutputSchema,
} from "./gleaner-left-contracts.ts";
export type { GleanerLeftOutput };
export { validateRecordedGleanerLeftOutput };

export type GleanerLeftOutputParameters = Static<typeof gleanerLeftOutputSchema>;

export type GleanerLeftRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 */
export const GLEANER_LEFT_TOOL_SPEC = roleSubmissionDeclaration("gleaner-left");
