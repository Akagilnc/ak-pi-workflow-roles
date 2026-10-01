import type { RoleHost, HostContext } from "./host-contracts.ts";

import { registerFiledSubmissionTool } from "./filed-submission.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";

export { REVIEWER_OUTPUT_TOOL_NAME, reviewerOutputSchema, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

/** Frozen admitted inputs the behavior layer may consume — no flag surface. */
export type ReviewerAdmittedInputs = Readonly<{
  baseRevision: string;
  lens: "completeness" | "correctness";
  authorityRefs?: readonly string[];
  /** Typed #176 ticketNumber from admitted invocation (Spec self-fetch primary). */
  ticketNumber?: number;
}>;

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
        registerFiledSubmissionTool(pi, roleSubmissionDeclaration("reviewer"), {
          readyError: () => (soul === undefined || soul.length === 0 ? "御史台输入未装载" : undefined),
        });
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
