import { Type } from "typebox";
import { isFullGitObjectId } from "./git-object-id.js";
import { exactUtf8 } from "./exact-utf8.js";
import { sha256Hex } from "./sha256.js";
const digestPattern = "^[0-9a-f]{64}$";
const oidPattern = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const materialSchema = Type.Object({ bytesBase64: Type.String(), sha256: Type.String({ pattern: digestPattern }) }, { additionalProperties: false });
const checkSchema = Type.Object({ name: Type.String({ minLength: 1 }), argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false });
export const mergerInputSchema = Type.Object({
    version: Type.Literal(1), attemptId: Type.String({ minLength: 1 }),
    targetObjectId: Type.String({ pattern: oidPattern }), sourceObjectId: Type.String({ pattern: oidPattern }),
    materials: Type.Object({ task: materialSchema, authority: materialSchema, targetIntent: materialSchema, sourceIntent: materialSchema }, { additionalProperties: false }),
    expectedConflictPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    resolutionScope: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    authorizedChecks: Type.Array(checkSchema),
}, { additionalProperties: false });
export const mergerOutputSchema = Type.Union([
    Type.Object({ status: Type.Literal("completed"), attemptId: Type.String({ minLength: 1 }), report: Type.String({ minLength: 1 }), mergeCommitId: Type.String({ pattern: oidPattern }) }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("escalate"), attemptId: Type.String({ minLength: 1 }), diagnosis: Type.String({ minLength: 1 }), report: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export const MERGER_OUTPUT_TOOL_NAME = "ak_merger_output";
export const MERGER_ACCEPTED_TEXT = "Merger output accepted";
const record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v, keys) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const blank = (v) => typeof v !== "string" || v.trim().length === 0;
function fail(message = "Merger input violates its exact contract") { throw new Error(message); }
function canonicalPath(path) { return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0") && path.split("/").every(part => part !== "" && part !== "." && part !== ".."); }
function validatePathSet(value, label) {
    if (!Array.isArray(value) || value.length === 0 || !value.every(canonicalPath))
        fail(`Merger ${label} must be a non-empty canonical path set`);
    const paths = value;
    const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (new Set(paths).size !== paths.length || paths.some((path, i) => path !== sorted[i]))
        fail(`Merger ${label} must be unique and canonical byte-sorted`);
    return paths;
}
function validateMaterial(value, label) {
    if (!record(value) || !exact(value, ["bytesBase64", "sha256"]) || typeof value.bytesBase64 !== "string" || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256))
        fail(`Merger ${label} material is malformed`);
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64)
        fail(`Merger ${label} bytes are not canonical base64`);
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
    if (!record(value) || !exact(value, ["version", "attemptId", "targetObjectId", "sourceObjectId", "materials", "expectedConflictPaths", "resolutionScope", "authorizedChecks"]) || value.version !== 1 || blank(value.attemptId) || !isFullGitObjectId(value.targetObjectId) || !isFullGitObjectId(value.sourceObjectId) || value.targetObjectId.length !== value.sourceObjectId.length)
        fail("Merger input has invalid identity or object ID");
    if (!record(value.materials) || !exact(value.materials, ["task", "authority", "targetIntent", "sourceIntent"]))
        fail();
    for (const key of ["task", "authority", "targetIntent", "sourceIntent"])
        validateMaterial(value.materials[key], key);
    const conflicts = validatePathSet(value.expectedConflictPaths, "expected conflict paths");
    const scope = validatePathSet(value.resolutionScope, "resolution scope");
    if (!conflicts.every(path => scope.includes(path)))
        fail("Merger resolution scope must contain the complete conflict set");
    if (!Array.isArray(value.authorizedChecks))
        fail("Merger authorized checks are malformed");
    const names = new Set();
    for (const check of value.authorizedChecks) {
        if (!record(check) || !exact(check, ["name", "argv"]) || blank(check.name) || !Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some(blank) || names.has(check.name))
            fail("Merger authorized check is malformed or duplicated");
        names.add(check.name);
    }
    return deepFreeze(structuredClone(value));
}
export function validateMergerOutput(value, expectedAttemptId) {
    if (!record(value) || blank(value.attemptId) || blank(value.report) || (expectedAttemptId !== undefined && value.attemptId !== expectedAttemptId))
        throw new Error("Merger output attempt mismatch or blank report");
    if (value.status === "completed" && exact(value, ["status", "attemptId", "report", "mergeCommitId"]) && isFullGitObjectId(value.mergeCommitId))
        return structuredClone(value);
    if (value.status === "escalate" && exact(value, ["status", "attemptId", "diagnosis", "report"]) && !blank(value.diagnosis))
        return structuredClone(value);
    throw new Error("Merger output violates the exact completed|escalate contract");
}
