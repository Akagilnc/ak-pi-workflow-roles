import { Type, type Static } from "typebox";
import { exactUtf8 } from "./exact-utf8.ts";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

const materialSchema = Type.Object({ bytesBase64: Type.String(), sha256: Type.String() }, { additionalProperties: false });
const checkSchema = Type.Object({ name: Type.String({ minLength: 1 }), argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false });
export const mergerInputSchema = Type.Object({
  attemptId: Type.String({ minLength: 1, description: "对账 attempt 身份（transport）" }),
  targetObjectId: Type.String({ description: "材料：target parent OID；可空" }),
  sourceObjectId: Type.String({ description: "材料：source parent OID；可空" }),
  materials: Type.Object({ task: materialSchema, authority: materialSchema, targetIntent: materialSchema, sourceIntent: materialSchema }, { additionalProperties: false }),
  expectedConflictPaths: Type.Array(Type.String(), { description: "材料：当前未合并路径；可空" }),
  resolutionScope: Type.Array(Type.String(), { description: "材料：解析范围提示；可空" }),
  authorizedChecks: Type.Array(checkSchema),
}, { additionalProperties: false });
// #836 r16 class 1: attemptId/report/diagnosis are LLM/human-read narrative
// content (candidate stored as submitted) — no code branches on their length.
// mergerInputSchema (host-authored material, not role output) is out of scope.
// #836 (ADR 0003 Amendment): status kept open like countersignStatus
// (src/countersign-role.ts) — one shared description across both variants
// so openToolObjectFromUnion's identical-declaration collapse drops none of it.
const MERGER_STATUS_DESCRIPTION = "completed | escalate — 形状指引，非 schema 闸" as const;
const mergerOutputVariants = Type.Union([
  Type.Object({ status: Type.Unknown({ description: MERGER_STATUS_DESCRIPTION }), attemptId: Type.String({ description: "已受理合并 attempt 身份" }), report: Type.String({ description: "如实结果报告" }), mergeCommitId: Type.String({ description: "完成合并 commit object ID" }) }, { additionalProperties: false }),
  Type.Object({ status: Type.Unknown({ description: MERGER_STATUS_DESCRIPTION }), attemptId: Type.String({ description: "已受理合并 attempt 身份" }), diagnosis: Type.String({ description: "合并无法或不应由本席完成的原因（含无进行中合并、无活可干、需新的产品/权力决定）" }), report: Type.String({ description: "如实结果报告" }) }, { additionalProperties: false }),
]);
export const mergerOutputSchema = withInfrastructureFailureDeclaration(openToolObjectFromUnion(mergerOutputVariants));

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type MergerMaterial = DeepReadonly<Static<typeof materialSchema>>;
export type MergerInput = DeepReadonly<Static<typeof mergerInputSchema>>;
export type MergerOutput =
  | { status: "completed"; attemptId: string; report: string; mergeCommitId: string }
  | { status: "escalate"; attemptId: string; diagnosis: string; report: string };
export const MERGER_OUTPUT_TOOL_NAME = "ak_merger_output";
export const MERGER_ACCEPTED_TEXT = "合并回执已接受";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const blank = (v: unknown) => typeof v !== "string" || v.trim().length === 0;
export class MergerInputContractError extends Error {
  constructor(message = "Merger input violates its exact contract") { super(message); this.name = "MergerInputContractError"; }
}
function fail(message = "Merger input violates its exact contract"): never { throw new MergerInputContractError(message); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }
const asString = (v: unknown): string => typeof v === "string" ? v : "";
const asStringArray = (v: unknown): string[] => Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];

function readMaterial(value: unknown, label: string): MergerMaterial {
  if (!record(value) || typeof value.bytesBase64 !== "string") fail(`Merger ${label} material is malformed`);
  exactUtf8(Buffer.from(value.bytesBase64, "base64"), `Merger ${label} material`);
  return { bytesBase64: value.bytesBase64, sha256: typeof value.sha256 === "string" ? value.sha256 : "" };
}

export function validateMergerInput(value: unknown): MergerInput {
  if (!record(value) || blank(value.attemptId)) fail("Merger input requires a non-empty attemptId for accounting");
  if (!record(value.materials)) fail("Merger materials are missing");
  const materials = { task: readMaterial(value.materials.task, "task"), authority: readMaterial(value.materials.authority, "authority"), targetIntent: readMaterial(value.materials.targetIntent, "targetIntent"), sourceIntent: readMaterial(value.materials.sourceIntent, "sourceIntent") };
  const authorizedChecks = Array.isArray(value.authorizedChecks) ? value.authorizedChecks.filter((check): check is Record<string, unknown> => record(check)).map(c => ({ name: asString(c.name), argv: asStringArray(c.argv).filter(a => a.trim().length > 0) })).filter(c => c.name.trim().length > 0 && c.argv.length > 0) : [];
  return deepFreeze(structuredClone({ attemptId: (value.attemptId as string).trim(), targetObjectId: asString(value.targetObjectId), sourceObjectId: asString(value.sourceObjectId), materials, expectedConflictPaths: asStringArray(value.expectedConflictPaths), resolutionScope: asStringArray(value.resolutionScope), authorizedChecks }) as MergerInput);
}

export function validateMergerOutput(value: unknown): MergerOutput {
  return value as MergerOutput;
}
