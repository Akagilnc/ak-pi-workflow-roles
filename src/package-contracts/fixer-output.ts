import { Type } from "typebox";
import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";

/** Owner 2026-09-28: partially_completed only when a lawful refusal exists; never otherwise (ADR 0015). */
export const PARTIALLY_COMPLETED_DEFINITION =
  "partially_completed 只能在有合法拒绝项（完成项与合法拒绝项并存）时用，别的情况不准用。" as const;
// status 的合法词写在 description。completed / partially_completed 进入提交闸；
// unfinished 且未见理由说明时，运行时同 run 催全（ADR 0050），理由在不在不按 JSON 类型判。
// 其余字段入账原样留存。声明只留字段名和语义说明，不留类型、嵌套、枚举、长度、必填。
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
      "各类 class 结算，原样留存（完成项可写 name、disposition、searchScope、exceptions（where、reason）、commitSha；拒绝项可写 name、disposition、remainingScope、blocker）。",
  }),
  testEvidence: Type.Unknown({
    description:
      "测试证据条；diff 含测试改动时提交；机器不核验。可写 contract（测试改动所证明的契约）、minimumNecessaryCost（测试改动的一行最小必要成本）、measuredDuration（聚焦验证实测时长）。",
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