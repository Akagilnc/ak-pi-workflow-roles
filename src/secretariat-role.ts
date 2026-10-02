/**
 * Secretariat (中书省) label and terminating decision-tool spec.
 * Lifecycle assembly (activate, register, prompt inject, inventory) lives on the
 * shared envelope — src/role-runtime.ts (ADR 0018 / #924).
 */
import type { Static } from "typebox";

import { SECRETARIAT_OUTPUT_TOOL_NAME, secretariatVerdictSchema, type SecretariatVerdict } from "./secretariat-contracts.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

export { SECRETARIAT_OUTPUT_TOOL_NAME } from "./secretariat-contracts.ts";
export type { SecretariatVerdict };

export { secretariatVerdictSchema } from "./secretariat-contracts.ts";

export type SecretariatVerdictParameters = Static<typeof secretariatVerdictSchema>;

export const SECRETARIAT_OUTPUT_TOOL_SPEC = roleSubmissionDeclaration("secretariat");

export type SecretariatRuntimeDependencies = {
  loadSoul(): Promise<string>;
};
