import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
import { Type } from "typebox";
import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

import { REVIEWER_OUTPUT_TOOL_NAME, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerIntent };

/** Frozen admitted inputs the behavior layer may consume — no flag surface. */
export type ReviewerAdmittedInputs = Readonly<{
  baseRevision: string;
  lens: "completeness" | "correctness";
  authorityRefs?: readonly string[];
  /** Typed #176 ticketNumber from admitted invocation (Spec self-fetch primary). */
  ticketNumber?: number;
}>;

const REVIEWER_AMENDMENTS_DESCRIPTION =
  "已运行 lens 的 amendments 承载 candidates、逐条处置与 verdict 的完整报告（非仅 verdict 行）；显式单轴时另一轴可省略（completeness / correctness）。hard-stop／usage error 为 refused 时，已产出报告仍照录对应 lens 字段。" as const;
// #1134: `status` alone is the trajectory field (#917 §6 two normal lens verdicts →
// completed; hard-stop / usage error → refused); its words ride the description.
// amendments/diagnostic are LLM/human-read narrative content returned as
// submitted — declaration keeps name + semantic description only, no nested
// object shape, no string type, no required constraint.
const REVIEWER_STATUS_DESCRIPTION =
  "completed | refused。两种正常 lens verdict（completeness / correctness）均 completed；hard-stop 与 usage error 为 refused（已产出报告仍照录进所选 lens amendments）。" as const;
const reviewerOutputObject = Type.Object({
  status: Type.Unknown({ description: REVIEWER_STATUS_DESCRIPTION }),
  amendments: Type.Unknown({ description: REVIEWER_AMENDMENTS_DESCRIPTION }),
  diagnostic: Type.Unknown({
    description: "拒绝诊断说明；hard-stop／usage error 原因进此字段，已产出报告另照录 amendments",
  }),
});
export const reviewerOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(reviewerOutputObject),
);
export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
};
export type ReviewerRoleHostActions = { failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never };

export type ReviewerActivation = Readonly<{
  fixedBaseRevision: string;
  soul: string;
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
  let registered = false;
  let fixedBaseRevision: string | undefined;

  return {
    async activate(_ctx, admitted) {
      soul = (await dependencies.loadSoul()).trim();
      if (!soul) throw new Error("Reviewer soul is empty");
      fixedBaseRevision = admitted.baseRevision;

      if (!registered) {
        registered = true;
        pi.registerTool({ name: REVIEWER_OUTPUT_TOOL_NAME, label: "御史台输出", description: "提交御史台终局回执。", promptSnippet: "提交御史台终局回执", parameters: reviewerOutputSchema,
          async execute(_id: string, parameters: unknown): Promise<HostToolResult<unknown>> {
            if (!soul) throw new Error("御史台输入未装载");
            return {
              content: [],
              details: parameters,
              terminate: true as const,
            };
          } });
      }
      const activatedSoul = soul;
      const activatedBase = fixedBaseRevision;
      return Object.freeze({
        fixedBaseRevision: activatedBase,
        soul: activatedSoul,
      });
    },
  };
}
