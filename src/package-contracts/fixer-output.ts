import { Type } from "typebox";
import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";

/** Owner 2026-09-28: partially_completed only when a lawful refusal exists; never otherwise (ADR 0015). */
export const PARTIALLY_COMPLETED_DEFINITION =
  "partially_completed 只能在有合法拒绝项（完成项与合法拒绝项并存）时用，别的情况不准用。" as const;
// #1134: `status` alone is the trajectory field AK reads to pick the next step
// (src/worker-submission-gates.ts:296-303, src/public-cli/settlement.ts), so its
// legal words live in the description every host shows the model. Every other
// field below is narrative or settlement content that lands on the ledger as
// submitted (src/submission-ledger.ts) and that no code branches on — its
// declaration keeps the field name and this semantic description only. Type,
// nesting, Literal, union, length and required constraints are deleted: the
// package declaration IS the host's pre-dispatch validator, so a constraint
// here is a rejection rule the owner never approved (owner 9ed9fa43-e814-40c4-
// afe6-879767bc6daf: 只有需要拿来判断走势的字段，才有格式/枚举要求).
const FIXER_STATUS_DESCRIPTION =
  `planned | completed | refused | unfinished | partially_completed。unfinished 缺前置或违宪约束致本局未完成时可用，缺待决 owner 决定或答复属缺前置。${PARTIALLY_COMPLETED_DEFINITION}` as const;

const fixerOutputObject = Type.Object({
  status: Type.Unknown({ description: FIXER_STATUS_DESCRIPTION }),
  report: Type.Unknown({ description: "如实结果报告" }),
  remainingScope: Type.Unknown({
    description: "本局后剩余工作；依法不能完成的范围也写此处。",
  }),
  blocker: Type.Unknown({
    description:
      "合法阻断完成的 blocker，原样留存（如 authority_violation 及其 evidence、prerequisite_unmet 及其 prerequisiteId、evidence）。",
  }),
  reason: Type.Unknown({
    description: "阻断原因：缺前置或违宪约束。缺待决 owner 决定或答复属缺前置。",
  }),
  classResults: Type.Unknown({
    description:
      "各类 class 结算，原样留存（完成项可写 name、disposition、searchScope、exceptions、commitSha；拒绝项可写 name、disposition、remainingScope、blocker）。",
  }),
  testEvidence: Type.Unknown({
    description: "测试证据条；diff 含测试改动时提交；机器不核验。",
  }),
});

export const fixerOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(fixerOutputObject),
);

export type FixerBlocker = Readonly<Record<string, unknown>>;
export type FixerClassResult = Readonly<Record<string, unknown>>;
export type FixerTestEvidence = Readonly<Record<string, unknown>>;
/**
 * One shared open receipt shape (#1134): every field is optional and carries no
 * type constraint, matching what `openToolObject` hands the host. The union of
 * per-status variants is gone — the declaration no longer discriminates, and the
 * trajectory word is read off `status` at runtime, not off the schema.
 */
export type FixerOutput = {
  readonly status?: unknown;
  readonly report?: unknown;
  readonly remainingScope?: unknown;
  readonly blocker?: unknown;
  readonly reason?: unknown;
  readonly classResults?: unknown;
  readonly testEvidence?: unknown;
};
export type FixerPhase = "plan" | "apply";

export function validateFixerOutput(value: unknown, _phase?: FixerPhase): FixerOutput {
  return value as FixerOutput;
}