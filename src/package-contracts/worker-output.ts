/** Package-owned independent Coder and Fixer output leaves. */

export {
  FIXER_ACCEPTED_TEXT,
  FIXER_OUTPUT_TOOL_NAME,
  fixerOutputSchema,
  validateFixerOutput,
  validateFixerOutputForPacket,
} from "./fixer-output.ts";
export type {
  FixerBlocker,
  FixerClassResult,
  FixerOutput,
  FixerPhase,
} from "./fixer-output.ts";
export { fixerPrerequisiteSchema, fixerPrerequisitesSchema, parseFixerPrerequisites, validateFixerPrerequisites } from "./fixer-packet.ts";
export type { FixerInvocationInput, FixerPrerequisite } from "./fixer-packet.ts";
import { validateFixerOutput, type FixerOutput } from "./fixer-output.ts";

export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export const CODER_ACCEPTED_TEXT = "Coder report accepted";
export type WorkerRoleLabel = "Coder" | "Fixer";
type CoderOutputClean =
  | { status: "planned"; report: string }
  | { status: "completed" | "refused"; report: string }
  | { status: "unfinished"; report: string; remainingScope: string; reason?: string };
export type CoderOutput = CoderOutputClean;
export type WorkerOutput =
  | CoderOutput
  | FixerOutput
  ;

export function validateAcceptedCoderDetails(output: unknown): CoderOutput {
  return output as CoderOutput;
}

/** Structural production validator for an accepted current leaf. */
export function validateAcceptedWorkerDetails(output: unknown, roleLabel: WorkerRoleLabel = "Coder"): WorkerOutput {
  return roleLabel === "Fixer" ? validateFixerOutput(output) : validateAcceptedCoderDetails(output);
}
