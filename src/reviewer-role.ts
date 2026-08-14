import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
import { disposeComplianceDecision } from "./audit-escalation.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { appendActiveSessionCustomEntry } from "./compliance-transport.ts";
import { REVIEWER_CANDIDATE_ENTRY_TYPE } from "./dossier-resolution.ts";
import {
  REVIEWER_VERIFICATION_BOUNDARY,
  type ReviewerSpecDisposition,
} from "./reviewer-construction.ts";
import { createReviewerDispatcher, type AcceptedReviewerDispatch, type AcceptedReviewerExecution, type ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
import { ReviewerDispatchExecutionError, type ReviewerDispatchRunResult } from "./reviewer-agent.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch, projectReviewerDispatchOutcome, type ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import { assembleRuntimeReviewerReceipt } from "./reviewer-settlement.ts";
import { REVIEWER_OUTPUT_TOOL_NAME, validateReviewerIntent, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerIntent };
export const AGENT_TOOL_NAME = "Agent";

/**
 * Private transport flag names/definitions for Reviewer admitted inputs.
 * Registration and decoding belong to the shared activation envelope (ADR 0018).
 */
export const REVIEWER_TRANSPORT_FLAGS = Object.freeze([
  Object.freeze({
    name: "ak-review-base",
    definition: Object.freeze({
      description: "Fixed base revision for the pinned review target",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-review-scope-keys",
    definition: Object.freeze({
      description: "Optional comma-separated exact class keys limiting Reviewer scope",
      type: "string" as const,
    }),
  }),
  Object.freeze({
    name: "ak-review-authority-refs",
    definition: Object.freeze({
      description: "JSON array of durable authority references for Spec evidence-child material only",
      type: "string" as const,
    }),
  }),
] as const);

/** Frozen admitted inputs the behavior layer may consume — no flag surface. */
export type ReviewerAdmittedInputs = Readonly<{
  baseRevision: string;
  reviewScopeKeys?: readonly string[];
  authorityRefs?: readonly string[];
}>;

/**
 * Decode private transport flags into frozen admitted inputs.
 * Envelope-owned call site; necessary JSON decode only (public --authority-ref owns grammar).
 */
export function decodeReviewerAdmittedInputs(getFlag: (name: string) => unknown): ReviewerAdmittedInputs {
  let reviewScopeKeys: readonly string[] | undefined;
  const rawScopeKeys = getFlag("ak-review-scope-keys");
  if (rawScopeKeys !== undefined) {
    if (typeof rawScopeKeys !== "string" || rawScopeKeys.length === 0) {
      throw new Error("Reviewer scope keys must be a nonempty comma-separated string");
    }
    const parsed = rawScopeKeys.split(",");
    if (parsed.some((key) => key.trim().length === 0) || new Set(parsed).size !== parsed.length) {
      throw new Error("Reviewer scope keys contain a blank or exact duplicate key");
    }
    reviewScopeKeys = Object.freeze(parsed);
  }

  let authorityRefs: readonly string[] | undefined;
  const rawAuthorityRefs = getFlag("ak-review-authority-refs");
  if (rawAuthorityRefs !== undefined) {
    if (typeof rawAuthorityRefs !== "string") {
      throw new Error("Reviewer authority refs transport error: flag value must be a string");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAuthorityRefs);
    } catch (error) {
      throw new Error(
        `Reviewer authority refs transport error: JSON decode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== "string")) {
      throw new Error("Reviewer authority refs transport error: expected a JSON array of strings");
    }
    authorityRefs = Object.freeze(parsed as string[]);
  }

  const baseRevision = getFlag("ak-review-base");
  if (typeof baseRevision !== "string" || !baseRevision.trim()) {
    throw new Error("Reviewer role requires --ak-review-base");
  }
  return Object.freeze({
    baseRevision,
    ...(reviewScopeKeys === undefined ? {} : { reviewScopeKeys }),
    ...(authorityRefs === undefined ? {} : { authorityRefs }),
  });
}

/**
 * Parent system-prompt assembly for the shared activation envelope.
 * References REVIEWER_VERIFICATION_BOUNDARY as the single text true source (no copy).
 */
export function assembleReviewerParentSystemPrompt(input: {
  baseSystemPrompt: string;
  soul: string;
  specDisposition?: ReviewerSpecDisposition;
}): string {
  const specDispositionNote =
    input.specDisposition === "skipped-missing"
      ? [
          "",
          "<reviewer_spec_disposition>",
          "Spec-Disposition: skipped-missing",
          "Independent discovery confirmed authoritative Spec is absent.",
          "No Spec evidence-child was launched. Note Spec skipped/missing honestly in the final report; do not invent requirements.",
          "</reviewer_spec_disposition>",
        ]
      : [];
  return [
    input.baseSystemPrompt,
    "",
    "<reviewer_soul>",
    input.soul,
    "</reviewer_soul>",
    "",
    "<reviewer_verification_boundary>",
    REVIEWER_VERIFICATION_BOUNDARY,
    "</reviewer_verification_boundary>",
    ...specDispositionNote,
  ].join("\n");
}

const reviewerOutputVariants = Type.Union([
  Type.Object({ status: Type.Literal("completed", { description: "Reviewer dispatch completed." }) }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("refused", { description: "Reviewer dispatch was lawfully refused." }), diagnostic: Type.String({ minLength: 1, description: "Diagnostic explaining the refusal." }) }, { additionalProperties: false }),
]);
const reviewerOutputSchema = openToolObjectFromUnion(reviewerOutputVariants);
export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadCanonicalSkillBinding(name: "code-review"): Promise<AnyCanonicalSkillBinding>;
  createPinnedGitReader(): Promise<ReviewerPinnedGitReader>;
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
  /** Honest Spec disposition after accepted dispatch, for envelope parent prompt assembly. */
  getSpecDisposition(): ReviewerSpecDisposition | undefined;
  /**
   * Behavior-layer Skill expansion capture. Envelope owns agent_start lifecycle and calls this
   * before assembling the parent system prompt.
   */
  captureCanonicalExpansion(prompt: string, toolCtx: ExtensionContext): void;
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
  let originalRequest: string | undefined;
  let expansionCaptured = false;
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
            if (output.status === "completed" && !expansionCaptured) throw new Error("Reviewer completed requires canonical Skill expansion capture");
            let record: ReviewerExecutionRecord;
            try { record = ledger.recordForAudit(output.status); } catch (error) { if ((error as any)?.fatalReviewerInfrastructure) hostActions.failInfrastructure(error, toolCtx, id); throw error; }
            const candidate = assembleRuntimeReviewerReceipt({
              intent: output,
              record,
              canonicalSkillText: binding.snapshot.raw,
            });
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
                auditIncomplete: (result) => result,
              },
              candidate,
            );
          } });
        pi.on("input", (event) => { if (originalRequest !== undefined) return { action: "continue" as const }; originalRequest = event.text; return { action: "transform" as const, text: binding!.invocation(event.text), ...(event.images === undefined ? {} : { images: event.images }) }; });
        // agent_start prompt lifecycle is owned by the shared activation envelope.
        pi.on("session_shutdown", async () => { try { await dependencies.shutdownAgent?.(); } catch (error) { throw ledger.recordInfrastructureFailure(error); } });
      }
      const activatedSoul = soul;
      const activatedBase = fixedBaseRevision;
      return Object.freeze({
        dispatcher,
        fixedBaseRevision: activatedBase,
        soul: activatedSoul,
        getSpecDisposition() {
          return acceptedDispatch?.specDisposition;
        },
        captureCanonicalExpansion(prompt: string, toolCtx: ExtensionContext) {
          if (expansionCaptured) return;
          if (originalRequest === undefined || binding!.captureExpansion(prompt, originalRequest) === undefined) {
            const error = ledger.recordInfrastructureFailure(new Error("Canonical code-review Skill expansion did not match the captured request"));
            hostActions.failInfrastructure(error, toolCtx);
          }
          expansionCaptured = true;
        },
      });
    },
  };
}
