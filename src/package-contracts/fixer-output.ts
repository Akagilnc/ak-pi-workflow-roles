import { Type, type Static } from "typebox";
import { openToolObjectFromUnion } from "../open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./terminating-infrastructure.ts";

export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const FIXER_ACCEPTED_TEXT = "修内司回执已接受";

// #836 r16 class 1: these are LLM/human-read narrative content — the candidate
// row lands on the ledger as submitted (src/submission-ledger.ts:351-390) and no
// code branches on its shape. Field/type/description/Literal value stay; provider
// required/minLength/minItems is deleted. `reason` alone keeps minLength: the
// worker gate reads `reason.trim().length > 0` to pick typed-reminder-bounce vs
// accept (src/worker-submission-gates.ts:159-163,297-302).
const transportString = Type.String();
const authorityBlockerSchema = Type.Object({ cause: Type.Optional(Type.Literal("authority_violation")), evidence: Type.Optional(transportString) });
const prerequisiteBlockerSchema = Type.Object({ cause: Type.Optional(Type.Literal("prerequisite_unmet")), prerequisiteId: Type.Optional(transportString), evidence: Type.Optional(transportString) });
const blockerSchema = Type.Union([authorityBlockerSchema, prerequisiteBlockerSchema]);
const exceptionSchema = Type.Object({ where: Type.Optional(transportString), reason: Type.Optional(transportString) });
/** ⑥ test evidence slip — require submit when diff has test changes; machine does not check existence/completeness/coverage. */
const testEvidenceSchema = Type.Object({
  contract: Type.Optional(Type.String({ description: "测试改动所证明的契约" })),
  minimumNecessaryCost: Type.Optional(Type.String({ description: "测试改动的一行最小必要成本" })),
  measuredDuration: Type.Optional(Type.String({ description: "聚焦验证实测时长" })),
}, { description: "测试证据条；diff 含测试改动时提交；机器不核验。" });
const completedClassResultSchema = Type.Object({
  name: Type.Optional(transportString),
  disposition: Type.Optional(Type.Literal("completed")),
  searchScope: Type.Optional(transportString),
  exceptions: Type.Optional(Type.Array(exceptionSchema)),
  commitSha: Type.Optional(transportString),
});
const refusedClassResultSchema = Type.Object({
  name: Type.Optional(transportString),
  disposition: Type.Optional(Type.Literal("refused")),
  remainingScope: Type.Optional(transportString),
  blocker: Type.Optional(blockerSchema),
});
const classResultSchema = Type.Union([completedClassResultSchema, refusedClassResultSchema]);
const completedClassResultsSchema = Type.Array(completedClassResultSchema);

// #836 (2026-09-11 御批 / ADR 0003 Amendment): `status` is the tool's own
// top-level machine discriminator (worker-submission-gates.ts reads it for
// WORKER_DONE_STATUSES gating). A closed provider-registered value domain
// would reject an unknown status before the submission ledger ever records
// it. Kept open (Type.Unknown, one shared description across every variant
// so openToolObjectFromUnion's identical-declaration collapse loses no
// guidance) like every other gate-queue status field in this package.
const FIXER_STATUS_DESCRIPTION =
  "planned | completed | refused | unfinished | partially_completed — 形状指引，非 schema 闸；unfinished 缺前置或违宪约束致本局未完成时可用，缺待决 owner 决定或答复属缺前置。" as const;
const fixerOutputVariants = Type.Union([
  Type.Object({ status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }), report: Type.String({ description: "如实结果报告" }) }),
  Type.Object({ status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }), report: Type.String({ description: "如实结果报告" }), remainingScope: Type.String({ description: "依法不能完成的工作范围" }), blocker: Type.Unsafe({ ...blockerSchema, description: "合法阻断完成的 blocker" }) }),
  Type.Object({ status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }), report: Type.String({ description: "如实结果报告" }), remainingScope: Type.String({ description: "本局后剩余工作" }), reason: Type.Optional(Type.String({ minLength: 1, description: "阻断原因：缺前置或违宪约束。缺待决 owner 决定或答复属缺前置。" })), classResults: Type.Optional(Type.Unsafe({ ...completedClassResultsSchema, description: "本局已完成的 class 结算" })), testEvidence: Type.Optional(testEvidenceSchema) }),
  Type.Object({ status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }), report: Type.String({ description: "如实结果报告" }), classResults: Type.Array(classResultSchema, { description: "已完成的 class 结算" }), testEvidence: Type.Optional(testEvidenceSchema) }),
  Type.Object({ status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }), report: Type.String({ description: "如实结果报告" }), classResults: Type.Array(classResultSchema, { description: "各类拒绝结算" }) }),
  Type.Object({ status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }), report: Type.String({ description: "如实结果报告" }), classResults: Type.Array(classResultSchema, { description: "各类完成或拒绝结算" }), testEvidence: Type.Optional(testEvidenceSchema) }),
]);
export const fixerOutputSchema = withInfrastructureFailureDeclaration(
  openToolObjectFromUnion(fixerOutputVariants),
);

export type FixerBlocker = Static<typeof blockerSchema>;
export type FixerClassResult = Static<typeof classResultSchema>;
export type FixerTestEvidence = Static<typeof testEvidenceSchema>;
export type FixerOutput = Static<typeof fixerOutputVariants>;
export type FixerPhase = "plan" | "apply";

export function validateFixerOutput(value: unknown, _phase?: FixerPhase): FixerOutput {
  return value as FixerOutput;
}
