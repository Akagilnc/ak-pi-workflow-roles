import { Type, type Static } from "typebox";
import { isFullGitObjectId } from "./git-object-id.ts";
import { exactUtf8 } from "./exact-utf8.ts";
import { sha256Hex } from "./sha256.ts";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";

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
  Type.Object({ status: Type.Literal("completed", { description: "Merge attempt completed." }), attemptId: Type.String({ minLength: 1, description: "Identity of the admitted merge attempt." }), report: Type.String({ minLength: 1, description: "Truthful merge outcome report." }), mergeCommitId: Type.String({ pattern: oidPattern, description: "Verified completed merge commit object ID." }) }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("escalate", { description: "Merge attempt requires human authority." }), attemptId: Type.String({ minLength: 1, description: "Identity of the admitted merge attempt." }), diagnosis: Type.String({ minLength: 1, description: "Reason merge completion requires escalation." }), report: Type.String({ minLength: 1, description: "Truthful merge outcome report." }) }, { additionalProperties: false }),
]);
export const mergerOutputSchema = openToolObjectFromUnion(mergerOutputVariants);

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type MergerMaterial = DeepReadonly<Static<typeof materialSchema>>;
export type MergerInput = DeepReadonly<Static<typeof mergerInputSchema>>;
export type MergerOutput =
  | { status: "completed"; attemptId: string; report: string; mergeCommitId: string }
  | { status: "escalate"; attemptId: string; diagnosis: string; report: string };
export const MERGER_OUTPUT_TOOL_NAME = "ak_merger_output";
export const MERGER_ACCEPTED_TEXT = "Merger output accepted";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const blank = (v: unknown) => typeof v !== "string" || v.trim().length === 0;
export class MergerInputContractError extends Error {
  constructor(message = "Merger input violates its exact contract") { super(message); this.name = "MergerInputContractError"; }
}
function fail(message = "Merger input violates its exact contract"): never { throw new MergerInputContractError(message); }
function canonicalPath(path: unknown): path is string { return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0") && path.split("/").every(part => part !== "" && part !== "." && part !== ".."); }
function validatePathSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(canonicalPath)) fail(`Merger ${label} must be a non-empty canonical path set`);
  return value as string[];
}
function validateMaterial(value: unknown, label: string): void {
  if (!record(value) || typeof value.bytesBase64 !== "string" || typeof value.sha256 !== "string") fail(`Merger ${label} material is malformed`);
  const bytes = Buffer.from(value.bytesBase64, "base64");
  exactUtf8(bytes, `Merger ${label} material`);
  if (sha256Hex(bytes) !== value.sha256) fail(`Merger ${label} material digest mismatch`);
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }

export function validateMergerInput(value: unknown): MergerInput {
  if (!record(value) || blank(value.attemptId) || !isFullGitObjectId(value.targetObjectId) || !isFullGitObjectId(value.sourceObjectId) || value.targetObjectId.length !== value.sourceObjectId.length) fail("Merger input has invalid identity or object ID");
  if (!record(value.materials)) fail();
  for (const key of ["task", "authority", "targetIntent", "sourceIntent"] as const) validateMaterial(value.materials[key], key);
  const conflicts = validatePathSet(value.expectedConflictPaths, "expected conflict paths");
  const scope = validatePathSet(value.resolutionScope, "resolution scope");
  if (!conflicts.every(path => scope.includes(path))) fail("Merger resolution scope must contain the complete conflict set");
  if (!Array.isArray(value.authorizedChecks)) fail("Merger authorized checks are malformed");
  for (const check of value.authorizedChecks) {
    if (!record(check) || !Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some(blank)) fail("Merger authorized check is malformed");
  }
  return deepFreeze(structuredClone(value) as MergerInput);
}

export function validateMergerOutput(value: unknown, expectedAttemptId?: string): MergerOutput {
  if (!record(value) || (expectedAttemptId !== undefined && value.attemptId !== expectedAttemptId)) throw new Error("Merger output attempt mismatch");
  if (value.status === "completed" && isFullGitObjectId(value.mergeCommitId)) return structuredClone(value) as MergerOutput;
  if (value.status === "escalate") return structuredClone(value) as MergerOutput;
  throw new Error("Merger output has no recognized execution discriminator");
}
