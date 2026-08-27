import { Type } from "typebox";
import { isFullGitObjectId } from "./git-object-id.js";
import { exactUtf8 } from "./exact-utf8.js";
import { sha256Hex } from "./sha256.js";
import { openToolObjectFromUnion } from "./open-tool-schema.js";
const oidPattern = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const materialSchema = Type.Object({ bytesBase64: Type.String(), sha256: Type.String() }, { additionalProperties: false });
const checkSchema = Type.Object({ name: Type.String({ minLength: 1 }), argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false });
export const mergerInputSchema = Type.Object({
    version: Type.Literal(1), attemptId: Type.String({ minLength: 1 }),
    targetObjectId: Type.String({ pattern: oidPattern }), sourceObjectId: Type.String({ pattern: oidPattern }),
    materials: Type.Object({ task: materialSchema, authority: materialSchema, targetIntent: materialSchema, sourceIntent: materialSchema }, { additionalProperties: false }),
    expectedConflictPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    resolutionScope: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    authorizedChecks: Type.Array(checkSchema),
}, { additionalProperties: false });
const mergerOutputVariants = Type.Union([
    Type.Object({ status: Type.Literal("completed", { description: "completed — 形状指引，非 schema 闸" }), attemptId: Type.String({ minLength: 1, description: "已受理合并 attempt 身份" }), report: Type.String({ minLength: 1, description: "如实结果报告" }), mergeCommitId: Type.String({ pattern: oidPattern, description: "已核验的完成合并 commit object ID" }) }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("escalate", { description: "escalate — 形状指引，非 schema 闸" }), attemptId: Type.String({ minLength: 1, description: "已受理合并 attempt 身份" }), diagnosis: Type.String({ minLength: 1, description: "合并完成需升级的原因" }), report: Type.String({ minLength: 1, description: "如实结果报告" }) }, { additionalProperties: false }),
]);
export const mergerOutputSchema = openToolObjectFromUnion(mergerOutputVariants);
export const MERGER_OUTPUT_TOOL_NAME = "ak_merger_output";
export const MERGER_ACCEPTED_TEXT = "合并回执已接受";
const record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const blank = (v) => typeof v !== "string" || v.trim().length === 0;
export class MergerInputContractError extends Error {
    constructor(message = "Merger input violates its exact contract") { super(message); this.name = "MergerInputContractError"; }
}
function fail(message = "Merger input violates its exact contract") { throw new MergerInputContractError(message); }
function canonicalPath(path) { return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0") && path.split("/").every(part => part !== "" && part !== "." && part !== ".."); }
function validatePathSet(value, label) {
    if (!Array.isArray(value) || value.length === 0 || !value.every(canonicalPath))
        fail(`Merger ${label} must be a non-empty canonical path set`);
    return value;
}
function validateMaterial(value, label) {
    if (!record(value) || typeof value.bytesBase64 !== "string" || typeof value.sha256 !== "string")
        fail(`Merger ${label} material is malformed`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    exactUtf8(bytes, `Merger ${label} material`);
    if (sha256Hex(bytes) !== value.sha256)
        fail(`Merger ${label} material digest mismatch`);
}
function deepFreeze(value) { if (value && typeof value === "object") {
    for (const child of Object.values(value))
        deepFreeze(child);
    Object.freeze(value);
} return value; }
export function validateMergerInput(value) {
    if (!record(value) || blank(value.attemptId) || !isFullGitObjectId(value.targetObjectId) || !isFullGitObjectId(value.sourceObjectId) || value.targetObjectId.length !== value.sourceObjectId.length)
        fail("Merger input has invalid identity or object ID");
    if (!record(value.materials))
        fail();
    for (const key of ["task", "authority", "targetIntent", "sourceIntent"])
        validateMaterial(value.materials[key], key);
    const conflicts = validatePathSet(value.expectedConflictPaths, "expected conflict paths");
    const scope = validatePathSet(value.resolutionScope, "resolution scope");
    if (!conflicts.every(path => scope.includes(path)))
        fail("Merger resolution scope must contain the complete conflict set");
    if (!Array.isArray(value.authorizedChecks))
        fail("Merger authorized checks are malformed");
    for (const check of value.authorizedChecks) {
        if (!record(check) || !Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some(blank))
            fail("Merger authorized check is malformed");
    }
    return deepFreeze(structuredClone(value));
}
export function validateMergerOutput(value, expectedAttemptId) {
    if (!record(value) || (expectedAttemptId !== undefined && value.attemptId !== expectedAttemptId))
        throw new Error("Merger output attempt mismatch");
    const status = typeof value.status === "string" ? value.status : undefined;
    if (status === "completed" && isFullGitObjectId(value.mergeCommitId))
        return structuredClone(value);
    if (status === "escalate")
        return structuredClone(value);
    throw new Error("Merger output has no recognized execution discriminator");
}
