import { Type, type Static } from "typebox";
import { FIXER_PREREQUISITE_ID_PATTERN, type FixerInvocationInput } from "./fixer-packet.ts";
import { openToolObjectFromUnion } from "../open-tool-schema.ts";

export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const FIXER_ACCEPTED_TEXT = "修内司回执已接受";

const nonblankTransportString = Type.String({ minLength: 1 });
const authorityBlockerSchema = Type.Object({ cause: Type.Literal("authority_violation"), evidence: nonblankTransportString });
const prerequisiteBlockerSchema = Type.Object({ cause: Type.Literal("prerequisite_unmet"), prerequisiteId: Type.String({ pattern: FIXER_PREREQUISITE_ID_PATTERN }), evidence: nonblankTransportString });
const blockerSchema = Type.Union([authorityBlockerSchema, prerequisiteBlockerSchema]);
const exceptionSchema = Type.Object({ where: nonblankTransportString, reason: nonblankTransportString });
/** ⑥ test evidence slip — require submit when diff has test changes; machine does not check existence/completeness/coverage. */
const testEvidenceSchema = Type.Object({
  contract: Type.String({ minLength: 1, description: "测试改动所证明的契约" }),
  minimumNecessaryCost: Type.String({ minLength: 1, description: "测试改动的一行最小必要成本" }),
  measuredDuration: Type.String({ minLength: 1, description: "聚焦验证实测时长" }),
}, { description: "测试证据条；diff 含测试改动时提交；机器不核验。" });
const completedClassResultSchema = Type.Object({
  name: nonblankTransportString,
  disposition: Type.Literal("completed"),
  searchScope: nonblankTransportString,
  exceptions: Type.Array(exceptionSchema),
  commitSha: nonblankTransportString,
});
const refusedClassResultSchema = Type.Object({
  name: nonblankTransportString,
  disposition: Type.Literal("refused"),
  remainingScope: nonblankTransportString,
  blocker: blockerSchema,
});
const classResultSchema = Type.Union([completedClassResultSchema, refusedClassResultSchema]);
const completedClassResultsSchema = Type.Array(completedClassResultSchema, { minItems: 1 });

const fixerOutputVariants = Type.Union([
  Type.Object({ status: Type.Literal("planned", { description: "planned — 形状指引，非 schema 闸" }), report: Type.String({ minLength: 1, description: "如实结果报告" }) }),
  Type.Object({ status: Type.Literal("refused", { description: "refused — 形状指引，非 schema 闸" }), report: Type.String({ minLength: 1, description: "如实结果报告" }), remainingScope: Type.String({ minLength: 1, description: "依法不能完成的工作范围" }), blocker: Type.Unsafe({ ...blockerSchema, description: "合法阻断完成的 blocker" }) }),
  Type.Object({ status: Type.Literal("unfinished", { description: "unfinished — 形状指引，非 schema 闸；缺前置或违宪约束致本局未完成时可用。缺待决 owner 决定或答复属缺前置。" }), report: Type.String({ minLength: 1, description: "如实结果报告" }), remainingScope: Type.String({ minLength: 1, description: "本局后剩余工作" }), reason: Type.Optional(Type.String({ minLength: 1, description: "阻断原因：缺前置或违宪约束。缺待决 owner 决定或答复属缺前置。" })), classResults: Type.Optional(Type.Unsafe({ ...completedClassResultsSchema, description: "本局已完成的 class 结算" })), testEvidence: Type.Optional(testEvidenceSchema) }),
  Type.Object({ status: Type.Literal("completed", { description: "completed — 形状指引，非 schema 闸" }), report: Type.String({ minLength: 1, description: "如实结果报告" }), classResults: Type.Array(classResultSchema, { minItems: 1, description: "已完成的 class 结算" }), testEvidence: Type.Optional(testEvidenceSchema) }),
  Type.Object({ status: Type.Literal("refused", { description: "refused — 形状指引，非 schema 闸" }), report: Type.String({ minLength: 1, description: "如实结果报告" }), classResults: Type.Array(classResultSchema, { minItems: 1, description: "各类拒绝结算" }) }),
  Type.Object({ status: Type.Literal("partially_completed", { description: "partially_completed — 形状指引，非 schema 闸" }), report: Type.String({ minLength: 1, description: "如实结果报告" }), classResults: Type.Array(classResultSchema, { minItems: 1, description: "各类完成或拒绝结算" }), testEvidence: Type.Optional(testEvidenceSchema) }),
]);
export const fixerOutputSchema = openToolObjectFromUnion(fixerOutputVariants);

export type FixerBlocker = Static<typeof blockerSchema>;
export type FixerClassResult = Static<typeof classResultSchema>;
export type FixerTestEvidence = Static<typeof testEvidenceSchema>;
export type FixerOutput = Static<typeof fixerOutputVariants>;
export type FixerPhase = "plan" | "apply";

export function validateFixerOutput(value: unknown, _phase?: FixerPhase): FixerOutput {
  return value as FixerOutput;
}

function safeProperty(value: unknown, property: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

/** Bind recognizable prerequisite blockers to the packet declaration. */
export function validateFixerOutputForPacket(value: unknown, phase: FixerPhase, packet: FixerInvocationInput): FixerOutput {
  const output = validateFixerOutput(value, phase);
  const declaredIds = new Set(packet.prerequisites.map((entry) => entry.id));
  const topLevelBlocker = safeProperty(output, "blocker");
  const classResults = safeProperty(output, "classResults");
  const blockers = topLevelBlocker === undefined
    ? (Array.isArray(classResults) ? classResults.map((entry) => safeProperty(entry, "blocker")) : [])
    : [topLevelBlocker];
  for (const blocker of blockers) {
    if (safeProperty(blocker, "cause") !== "prerequisite_unmet") continue;
    const prerequisiteId = safeProperty(blocker, "prerequisiteId");
    if (typeof prerequisiteId === "string" && !declaredIds.has(prerequisiteId)) {
      throw new Error("Fixer output violates blocker.prerequisiteId declared-prerequisite constraint");
    }
  }
  return output;
}
