/** Package-owned independent Coder and Fixer output leaves. */
export { FIXER_ACCEPTED_TEXT, FIXER_OUTPUT_TOOL_NAME, fixerOutputSchema, validateFixerOutput, validateFixerOutputForPacket, } from "./fixer-output.js";
export { fixerPrerequisiteSchema, fixerPrerequisitesSchema, parseFixerPrerequisites, validateFixerPrerequisites } from "./fixer-packet.js";
import { validateFixerOutput } from "./fixer-output.js";
export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export const CODER_ACCEPTED_TEXT = "Coder report accepted";
export function validateAcceptedCoderDetails(output) {
    return output;
}
/** Structural production validator for an accepted current leaf. */
export function validateAcceptedWorkerDetails(output, roleLabel = "Coder") {
    return roleLabel === "Fixer" ? validateFixerOutput(output) : validateAcceptedCoderDetails(output);
}
