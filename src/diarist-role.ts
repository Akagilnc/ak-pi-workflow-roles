import type { Static } from "typebox";

import {
  DIARIST_OUTPUT_TOOL_NAME,
  diaristOutputSchema,
  validateRecordedDiaristOutput,
  type DiaristOutput,
} from "./diarist-contracts.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

export {
  DIARIST_OUTPUT_TOOL_NAME,
  diaristOutputSchema,
} from "./diarist-contracts.ts";
export type { DiaristOutput };
export { validateRecordedDiaristOutput };

export type DiaristOutputParameters = Static<typeof diaristOutputSchema>;

export type DiaristRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 */
export const DIARIST_TOOL_SPEC = roleSubmissionDeclaration("diarist");
