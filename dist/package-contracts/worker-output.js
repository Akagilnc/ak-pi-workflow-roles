/** Package-owned independent Coder and Fixer output leaves. */
export { FIXER_ACCEPTED_TEXT, FIXER_OUTPUT_TOOL_NAME, fixerOutputSchema, validateFixerOutput, validateFixerOutputForPacket, } from "./fixer-output.js";
export { fixerPacketV1Schema, fixerPrerequisiteSchema, parseFixPacketV1, validateFixPacketV1 } from "./fixer-packet.js";
import { validateFixerOutput } from "./fixer-output.js";
export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export const CODER_ACCEPTED_TEXT = "Coder report accepted";
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function validateAcceptedCoderDetails(output) {
    if (!record(output))
        throw new Error("Coder output must be an object");
    const keys = ["status", "report", ...(output.commitSha === undefined ? [] : ["commitSha"])];
    if (!exact(output, keys) || (output.status !== "planned" && output.status !== "completed" && output.status !== "refused") ||
        typeof output.report !== "string" || output.report.trim().length === 0 ||
        (output.commitSha !== undefined && (typeof output.commitSha !== "string" || output.commitSha.trim().length === 0)) ||
        (output.status === "planned" && output.commitSha !== undefined)) {
        throw new Error("Coder output requires planned|completed|refused, a non-blank report, and a lawful optional commitSha");
    }
    return { status: output.status, report: output.report, ...(output.commitSha === undefined ? {} : { commitSha: output.commitSha }) };
}
/** Structural production validator for an accepted current leaf. */
export function validateAcceptedWorkerDetails(output, roleLabel = "Coder") {
    return roleLabel === "Fixer" ? validateFixerOutput(output) : validateAcceptedCoderDetails(output);
}
