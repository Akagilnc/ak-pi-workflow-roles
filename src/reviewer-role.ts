import type { RoleHost, HostContext, HostToolResult } from "./host-contracts.ts";
import { Type } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
export type { CanonicalSkillBinding };
import { type ReviewerPinnedGitReader } from "./reviewer-pinned-git.ts";
import { REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerIntent };
export const AGENT_TOOL_NAME = "Agent";

/** Frozen admitted inputs the behavior layer may consume — no flag surface. */
export type ReviewerAdmittedInputs = Readonly<{
  baseRevision: string;
  reviewScopeKeys?: readonly string[];
  authorityRefs?: readonly string[];
  /** Typed #176 ticketNumber from admitted invocation (Spec self-fetch primary). */
  ticketNumber?: number;
}>;

const reviewerAmendmentsSchema = Type.Object({
  standards: Type.Optional(Type.String({ description: "相对 Standards 子报告的增量：增 finding、撤回或事实更正" })),
  spec: Type.Optional(Type.String({ description: "相对 Spec 子报告的增量：增 finding、撤回或事实更正" })),
}, { additionalProperties: true, description: "相对子报告的可选轴增量；非替代报告。无增量的轴可省略。" });
// #836 r16 class 1: diagnostic is LLM/human-read narrative content — no code
// branches on its length (src/reviewer-role.ts consumer: reviewer content is
// returned as submitted, ADR 0057).
const reviewerOutputVariants = Type.Union([
  Type.Object({
    status: Type.Literal("completed", { description: "completed — 形状指引，非 schema 闸" }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("refused", { description: "refused — 形状指引，非 schema 闸" }),
    diagnostic: Type.String({ description: "拒绝诊断说明" }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
]);
export const reviewerOutputSchema = withInfrastructureFailureDeclaration(
  openToolObjectFromUnion(reviewerOutputVariants),
);
export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadCanonicalSkillBinding(name: "code-review"): Promise<AnyCanonicalSkillBinding>;
  createPinnedGitReader(): Promise<ReviewerPinnedGitReader>;
};
export type ReviewerRoleHostActions = { failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never };


export type ReviewerActivation = Readonly<{
  fixedBaseRevision: string;
  soul: string;
  /** Frozen code-review binding — envelope owns expansion capture against this data. */
  skillBinding: CanonicalSkillBinding<"code-review">;
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
  let binding: CanonicalSkillBinding<"code-review"> | undefined;
  let registered = false;
  let fixedBaseRevision: string | undefined;

  return {
    async activate(_ctx, admitted) {
      soul = (await dependencies.loadSoul()).trim();
      if (!soul) throw new Error("Reviewer soul is empty");
      fixedBaseRevision = admitted.baseRevision;
      const loaded = await dependencies.loadCanonicalSkillBinding("code-review");
      if (loaded.name !== "code-review") throw new Error("Canonical Skill binding loader returned tdd for code-review");
      binding = loaded;

      if (!registered) {
        registered = true;
        pi.registerTool({ name: REVIEWER_OUTPUT_TOOL_NAME, label: "御史台输出", description: "提交御史台终局回执。本席自调 code-review skill。", promptSnippet: "提交御史台终局回执", parameters: reviewerOutputSchema,
          async execute(_id: string, parameters: unknown): Promise<HostToolResult<unknown>> {
            if (!soul || !binding) throw new Error("御史台输入未装载");
            return {
              content: [{ type: "text" as const, text: REVIEWER_ACCEPTED_TEXT }],
              details: parameters,
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
