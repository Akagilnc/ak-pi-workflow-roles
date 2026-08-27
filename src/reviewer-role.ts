import type { RoleHost, HostContext, HostToolResult, HostToolDefinition } from "./host-contracts.ts";
import { Type } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
export type { CanonicalSkillBinding };
import { type ReviewerSpecDisposition } from "./reviewer-construction.ts";
import { createReviewerDispatcher, type AcceptedReviewerDispatch, type AcceptedReviewerExecution, type ReviewerIssueFetcher, type ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
import { ReviewerDispatchExecutionError, type ReviewerDispatchRunResult } from "./reviewer-agent.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch, projectReviewerDispatchOutcome, type ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import { assembleRuntimeReviewerReceipt } from "./reviewer-settlement.ts";
import { REVIEWER_ACCEPTED_TEXT, REVIEWER_OUTPUT_TOOL_NAME, validateReviewerIntent, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

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
const reviewerOutputVariants = Type.Union([
  Type.Object({
    status: Type.Literal("completed", { description: "completed — 形状指引，非 schema 闸" }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("refused", { description: "refused — 形状指引，非 schema 闸" }),
    diagnostic: Type.String({ minLength: 1, description: "拒绝诊断说明" }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
]);
const reviewerOutputSchema = openToolObjectFromUnion(reviewerOutputVariants);
export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadCanonicalSkillBinding(name: "code-review"): Promise<AnyCanonicalSkillBinding>;
  createPinnedGitReader(): Promise<ReviewerPinnedGitReader>;
  /** Injected issue-fetch capability; shared seam owns gh lifecycle. */
  fetchIssue?: ReviewerIssueFetcher;
  runDispatch(execution: AcceptedReviewerExecution, options: { context: HostContext; signal?: AbortSignal }): Promise<ReviewerDispatchRunResult>;
  shutdownAgent?(): Promise<void>;
};
export type ReviewerRoleHostActions = { failInfrastructure(error: unknown, ctx: HostContext, toolCallId?: string): never };

function requireSoleReviewerOutputCall(id: string, ctx: HostContext): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("御史台回执非唯一终局工具调用");
  const calls = leaf.message.content.filter((part: any) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== id || calls[0]?.name !== REVIEWER_OUTPUT_TOOL_NAME) throw new Error("御史台回执非唯一终局工具调用");
}

export type ReviewerActivation = Readonly<{
  dispatcher: ReturnType<typeof createReviewerDispatcher>;
  fixedBaseRevision: string;
  soul: string;
  /** Frozen code-review binding — envelope owns expansion capture against this data. */
  skillBinding: CanonicalSkillBinding<"code-review">;
  /** Honest Spec disposition after accepted dispatch, for envelope parent prompt assembly. */
  getSpecDisposition(): ReviewerSpecDisposition | undefined;
}>;

/**
 * Reviewer behavior runtime: label, soul, evidence tools, decision tool, projection.
 * No flag registration/decoding and no agent_start prompt lifecycle (ADR 0018 / envelope).
 * Reviewer-side 审刑院 gate retired (#495 S6 / 风闻奏事); accept on typed validate only.
 */
export function createReviewerRoleRuntime(
  pi: RoleHost,
  dependencies: ReviewerRoleDependencies,
  hostActions: ReviewerRoleHostActions,
): {
  activate(ctx: HostContext | undefined, admitted: ReviewerAdmittedInputs): Promise<ReviewerActivation>;
} {
  let soul: string | undefined;
  let binding: CanonicalSkillBinding<"code-review"> | undefined;
  let reader: ReviewerPinnedGitReader | undefined;
  let dispatcher: ReturnType<typeof createReviewerDispatcher> | undefined;
  let registered = false;
  let fixedBaseRevision: string | undefined;
  let acceptedDispatch: AcceptedReviewerDispatch | undefined;
  const ledger = createReviewerExecutionLedger();

  return {
    async activate(_ctx, admitted) {
      soul = (await dependencies.loadSoul()).trim();
      if (!soul) throw new Error("Reviewer soul is empty");
      // Behavior layer receives frozen admitted inputs only — no pi.getFlag.
      fixedBaseRevision = admitted.baseRevision;
      const reviewScopeKeys = admitted.reviewScopeKeys;
      const authorityRefs = admitted.authorityRefs;
      const ticketNumber = admitted.ticketNumber;
      const loaded = await dependencies.loadCanonicalSkillBinding("code-review");
      if (loaded.name !== "code-review") throw new Error("Canonical Skill binding loader returned tdd for code-review");
      binding = loaded;
      reader = await dependencies.createPinnedGitReader();

      acceptedDispatch = undefined;
      const executeAndProjectDispatch = async (execution: AcceptedReviewerExecution, invocation: unknown): Promise<ReviewerDispatchRunResult> => {
        const dispatch = acceptedDispatch;
        if (dispatch === undefined || dispatch.identity !== execution.identity) throw new Error("Reviewer execution lacks accepted construction evidence");
        const { context, signal } = invocation as { context: HostContext; signal?: AbortSignal };
        ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: execution.identity, cardinality: execution.legs.length as 1 | 2 });
        try {
          const result = await dependencies.runDispatch(execution, { context, ...(signal === undefined ? {} : { signal }) });
          projectReviewerDispatchOutcome(ledger, dispatch, result);
          return result;
        } catch (error) {
          if (error instanceof ReviewerDispatchExecutionError) {
            try { projectReviewerDispatchOutcome(ledger, dispatch, error.outcome); }
            catch (mismatch) { throw ledger.recordInfrastructureFailure(mismatch); }
            throw error;
          }
          throw ledger.recordInfrastructureFailure(error);
        }
      };
      dispatcher = createReviewerDispatcher({
        canonicalSkill: binding.snapshot.raw,
        reader,
        ...(reviewScopeKeys === undefined ? {} : { reviewScopeKeys }),
        ...(authorityRefs === undefined ? {} : { authorityRefs }),
        ...(ticketNumber === undefined ? {} : { ticketNumber }),
        ...(dependencies.fetchIssue === undefined ? {} : { fetchIssue: dependencies.fetchIssue }),
        decisionEvidence(decision) {
          try {
            if (decision.disposition === "accepted") {
              ledger.append(projectAcceptedDispatch(decision.dispatch));
              acceptedDispatch = decision.dispatch;
            } else ledger.append({ source: "reviewer-dispatch", type: "rejected", identity: decision.identity, violations: decision.violations, started: false });
          } catch (error) {
            throw ledger.recordInfrastructureFailure(error);
          }
        },
        run: executeAndProjectDispatch,
      });

      if (!registered) {
        registered = true;
        pi.registerTool({ name: REVIEWER_OUTPUT_TOOL_NAME, label: "御史台输出", description: "Standards/Spec 评审腿由 runtime 以取证子会话代跑，本席收腿报告后交薄回执。", promptSnippet: "提交御史台终局回执", parameters: reviewerOutputSchema,
          async execute(id: string, parameters: any, _signal: AbortSignal | undefined, _update: any, toolCtx: HostContext): Promise<HostToolResult<unknown>> {
            if (!soul || !binding) throw new Error("御史台输入未装载");
            requireSoleReviewerOutputCall(id, toolCtx);
            const output = validateReviewerIntent(parameters);
            let record: ReviewerExecutionRecord;
            try { record = ledger.recordForAudit(output.status); } catch (error) { if ((error as any)?.fatalReviewerInfrastructure) hostActions.failInfrastructure(error, toolCtx, id); throw error; }
            const candidate = assembleRuntimeReviewerReceipt({
                intent: output,
                record,
                canonicalSkillText: binding.snapshot.raw,
              });
            try { await dependencies.shutdownAgent?.(); } catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx, id); }
            return {
              content: [{ type: "text" as const, text: REVIEWER_ACCEPTED_TEXT }],
              details: candidate,
              terminate: true as const,
            };
          } });
        // Skill invocation transform + agent_start expansion/prompt lifecycle: shared envelope (ADR 0018).
        pi.on("session_shutdown", async () => { try { await dependencies.shutdownAgent?.(); } catch (error) { throw ledger.recordInfrastructureFailure(error); } });
      }
      const activatedSoul = soul;
      const activatedBase = fixedBaseRevision;
      const activatedBinding = binding;
      return Object.freeze({
        dispatcher,
        fixedBaseRevision: activatedBase,
        soul: activatedSoul,
        skillBinding: activatedBinding,
        getSpecDisposition() {
          return acceptedDispatch?.specDisposition;
        },
      });
    },
  };
}
