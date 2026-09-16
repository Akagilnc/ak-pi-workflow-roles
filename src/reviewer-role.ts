import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
import { Type } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
export type { CanonicalSkillBinding };
import { REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerIntent };

/** Frozen admitted inputs the behavior layer may consume — no flag surface. */
export type ReviewerAdmittedInputs = Readonly<{
  baseRevision: string;
  /** Parallel two-axis default, or caller-selected single-axis override. */
  lens: "all" | "completeness" | "correctness";
  authorityRefs?: readonly string[];
  /** Typed #176 ticketNumber from admitted invocation (Spec self-fetch primary). */
  ticketNumber?: number;
}>;

const reviewerAmendmentsSchema = Type.Object({
  completeness: Type.Optional(Type.String({
    description:
      "completeness lens 完整报告：candidates、逐条处置与 verdict；非仅 verdict 一行。hard-stop／usage error 为 refused 时，若已产出报告仍照录于此",
  })),
  correctness: Type.Optional(Type.String({
    description:
      "correctness lens 完整报告：candidates、逐条处置与 verdict；非仅 verdict 一行。hard-stop／usage error 为 refused 时，若已产出报告仍照录于此",
  })),
}, {
  additionalProperties: true,
  description:
    "已运行 lens 的 amendments 承载 candidates、逐条处置与 verdict 的完整报告（非仅 verdict 行）；显式单轴时另一轴可省略。hard-stop／usage error 为 refused 时，已产出报告仍照录对应 lens 字段。形状指引，非 schema 闸。",
});
// #836 r16 class 1: diagnostic is LLM/human-read narrative content — no code
// branches on its length (src/reviewer-role.ts consumer: reviewer content is
// returned as submitted, ADR 0057).
// #836 (ADR 0003 Amendment): status kept open like countersignStatus
// (src/countersign-role.ts) — one shared description across both variants
// so openToolObjectFromUnion's identical-declaration collapse drops none of it.
// #917 §6: both normal lens verdicts → completed; hard-stop/usage error → refused
// (report already produced still lands in selected-lens amendments).
const REVIEWER_STATUS_DESCRIPTION =
  "completed | refused — 形状指引，非 schema 闸。两种正常 lens verdict（completeness / correctness）均 completed；hard-stop 与 usage error 为 refused（已产出报告仍照录进所选 lens amendments）。" as const;
const reviewerOutputVariants = Type.Union([
  Type.Object({
    status: Type.Unknown({ description: REVIEWER_STATUS_DESCRIPTION }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Unknown({ description: REVIEWER_STATUS_DESCRIPTION }),
    diagnostic: Type.String({ description: "拒绝诊断说明；hard-stop／usage error 原因进此字段，已产出报告另照录 amendments" }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
]);
export const reviewerOutputSchema = withTerminatingOutputDeclarations(
  openToolObjectFromUnion(reviewerOutputVariants),
);
export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadCanonicalSkillBinding(name: "ak-cross-m-review"): Promise<AnyCanonicalSkillBinding>;
  projectSubmission?(parameters: unknown): unknown;
};
export type ReviewerRoleHostActions = { failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never };


export type ReviewerActivation = Readonly<{
  fixedBaseRevision: string;
  soul: string;
  /** Frozen ak-cross-m-review binding — envelope owns expansion capture against this data. */
  skillBinding: CanonicalSkillBinding<"ak-cross-m-review">;
}>;

/**
 * Reviewer behavior runtime: label, soul, evidence tools, decision tool, projection.
 * No flag registration/decoding and no agent_start prompt lifecycle (ADR 0018 / envelope).
 * Reviewer-side 审刑院 gate retired (#495 S6 / 风闻奏事); accept on typed validate only.
 */
export function createReviewerRoleRuntime(
  pi: RoleHost,
  dependencies: ReviewerRoleDependencies,
  _hostActions: ReviewerRoleHostActions,
): {
  activate(ctx: HostContext | undefined, admitted: ReviewerAdmittedInputs): Promise<ReviewerActivation>;
} {
  let soul: string | undefined;
  let binding: CanonicalSkillBinding<"ak-cross-m-review"> | undefined;
  let registered = false;
  let fixedBaseRevision: string | undefined;

  return {
    async activate(_ctx, admitted) {
      soul = (await dependencies.loadSoul()).trim();
      if (!soul) throw new Error("Reviewer soul is empty");
      fixedBaseRevision = admitted.baseRevision;
      const loaded = await dependencies.loadCanonicalSkillBinding("ak-cross-m-review");
      if (loaded.name !== "ak-cross-m-review") throw new Error("Canonical Skill binding loader returned tdd for ak-cross-m-review");
      binding = loaded;

      if (!registered) {
        registered = true;
        pi.registerTool({ name: REVIEWER_OUTPUT_TOOL_NAME, label: "御史台输出", description: "提交御史台终局回执。本席自调 ak-cross-m-review skill。", promptSnippet: "提交御史台终局回执", parameters: reviewerOutputSchema,
          async execute(_id: string, parameters: unknown): Promise<HostToolResult<unknown>> {
            if (!soul || !binding) throw new Error("御史台输入未装载");
            return {
              content: [{ type: "text" as const, text: REVIEWER_ACCEPTED_TEXT }],
              details: dependencies.projectSubmission?.(parameters) ?? parameters,
              terminate: true as const,
            };
          } });
      }
      const activatedSoul = soul;
      const activatedBase = fixedBaseRevision;
      const activatedBinding = binding;
      return Object.freeze({
        fixedBaseRevision: activatedBase,
        soul: activatedSoul,
        skillBinding: activatedBinding,
      });
    },
  };
}
