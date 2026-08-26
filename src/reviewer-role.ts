import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
export type { CanonicalSkillBinding };
import { disposeComplianceDecision } from "./audit-escalation.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { appendActiveSessionCustomEntry } from "./compliance-transport.ts";
import {
  readActivationEngineLaborFallbackField,
  withEngineLaborFallbackField,
} from "./engine-labor-fallback.ts";
import { REVIEWER_CANDIDATE_ENTRY_TYPE } from "./dossier-resolution.ts";
import { type ReviewerSpecDisposition } from "./reviewer-construction.ts";
import { createReviewerDispatcher, type AcceptedReviewerDispatch, type AcceptedReviewerExecution, type ReviewerIssueFetcher, type ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
import { ReviewerDispatchExecutionError, type ReviewerDispatchRunResult } from "./reviewer-agent.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch, projectReviewerDispatchOutcome, type ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import { assembleRuntimeReviewerReceipt } from "./reviewer-settlement.ts";
import { REVIEWER_OUTPUT_TOOL_NAME, validateReviewerIntent, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

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
  standards: Type.Optional(Type.String({ description: "Delta relative to the Standards child report: added finding, withdrawal, or factual correction." })),
  spec: Type.Optional(Type.String({ description: "Delta relative to the Spec child report: added finding, withdrawal, or factual correction." })),
}, { additionalProperties: true, description: "Optional per-axis deltas relative to child reports; not a replacement report. Omit axes with no delta." });
const reviewerOutputVariants = Type.Union([
  Type.Object({
    status: Type.Literal("completed", { description: "Reviewer dispatch completed." }),
    amendments: Type.Optional(reviewerAmendmentsSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("refused", { description: "Reviewer dispatch was lawfully refused." }),
    diagnostic: Type.String({ minLength: 1, description: "Diagnostic explaining the refusal." }),
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
  runDispatch(execution: AcceptedReviewerExecution, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ReviewerDispatchRunResult>;
  shutdownAgent?(): Promise<void>;
  auditCompliance(options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
};
export type ReviewerRoleHostActions = { failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never };

function requireSoleReviewerOutputCall(id: string, ctx: ExtensionContext): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("Reviewer output must be the sole final tool call");
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== id || calls[0]?.name !== REVIEWER_OUTPUT_TOOL_NAME) throw new Error("Reviewer output must be the sole final tool call");
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
 */
export function createReviewerRoleRuntime(
  pi: ExtensionAPI,
  dependencies: ReviewerRoleDependencies,
  hostActions: ReviewerRoleHostActions,
): {
  activate(ctx: ExtensionContext | undefined, admitted: ReviewerAdmittedInputs): Promise<ReviewerActivation>;
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
        const { context, signal } = invocation as { context: ExtensionContext; signal?: AbortSignal };
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
        pi.registerTool({ name: REVIEWER_OUTPUT_TOOL_NAME, label: "Reviewer Output", description: "Submit the thin Reviewer receipt after semantic compliance audit.", promptSnippet: "Submit the final Reviewer receipt", promptGuidelines: [`Use ${REVIEWER_OUTPUT_TOOL_NAME} as the sole final action.`,
            "This runtime executes the Standards and Spec review legs for you as package-managed evidence-child sessions — that IS this runtime's implementation of the review Skill's parallel sub-agents. Do not refuse because no Agent tool appears in your tool list, and do not substitute your own sub-processes; work with the legs the runtime provides. The same rule applies to corrections and redos after an auditor bounce-back: complete them in this session with your own tools. Evidence-leg model and thinking tier follow the seat's active order; the reviewer seat does not choose them."], parameters: reviewerOutputSchema,
          async execute(id, parameters, signal, _update, toolCtx): Promise<AgentToolResult<unknown>> {
            if (!soul || !binding) throw new Error("Reviewer inputs were not loaded");
            requireSoleReviewerOutputCall(id, toolCtx);
            const output = validateReviewerIntent(parameters);
            let record: ReviewerExecutionRecord;
            try { record = ledger.recordForAudit(output.status); } catch (error) { if ((error as any)?.fatalReviewerInfrastructure) hostActions.failInfrastructure(error, toolCtx, id); throw error; }
            const candidate = withEngineLaborFallbackField(
              assembleRuntimeReviewerReceipt({
                intent: output,
                record,
                canonicalSkillText: binding.snapshot.raw,
              }),
              // #380: sole-built declaration when any leg detour fell back to seat labor.
              readActivationEngineLaborFallbackField(),
            );
            // First-record-then-audit: candidate lands on the parent session books
            // before the auditor is spawned (zero hand-delivery).
            try {
              appendActiveSessionCustomEntry(
                toolCtx,
                REVIEWER_CANDIDATE_ENTRY_TYPE,
                { version: 1, candidate },
                {
                  unavailable: "reviewer candidate retention is unavailable",
                  failed: "reviewer candidate retention failed",
                },
              );
            } catch (error) {
              hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx, id);
            }
            let audit: ComplianceDecision;
            try {
              audit = await dependencies.auditCompliance({
                context: toolCtx,
                ...(signal === undefined ? {} : { signal }),
              });
            }
            catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx, id); }
            return disposeComplianceDecision<AgentToolResult<unknown>>(
              audit,
              {
                pass: async (usage) => {
                  try { await dependencies.shutdownAgent?.(); } catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx, id); }
                  return { content: [{ type: "text" as const, text: "Reviewer report accepted" }], details: candidate, terminate: true as const, ...(usage === undefined ? {} : { usage }) };
                },
                noReceipt: async (auditNoReceipt, usageProjection) => {
                  try { await dependencies.shutdownAgent?.(); } catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx, id); }
                  return { content: [{ type: "text" as const, text: "Reviewer report accepted; compliance audit produced no receipt" }], details: { ...candidate, auditNoReceipt }, terminate: true as const, ...usageProjection };
                },
                revise: (violations) => {
                  throw new AggregateError([], `Reviewer receipt rejected:\n${violations.join("\n")}`, { cause: Object.freeze([...violations]) });
                },
                escalate: async (result) => {
                  try { await dependencies.shutdownAgent?.(); } catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx, id); }
                  return result;
                },
              },
              candidate,
            );
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
