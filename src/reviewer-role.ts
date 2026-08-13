import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
import { disposeComplianceDecision } from "./audit-escalation.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { appendActiveSessionCustomEntry } from "./compliance-transport.ts";
import { REVIEWER_CANDIDATE_ENTRY_TYPE } from "./dossier-resolution.ts";
import { createReviewerDispatcher, type AcceptedReviewerDispatch, type AcceptedReviewerExecution, type ReviewerPinnedGitReader } from "./reviewer-dispatch.ts";
import { ReviewerDispatchExecutionError, type ReviewerDispatchRunResult } from "./reviewer-agent.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch, projectReviewerDispatchOutcome, type ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import { assembleRuntimeReviewerReceipt } from "./reviewer-settlement.ts";
import { REVIEWER_OUTPUT_TOOL_NAME, validateReviewerIntent, type ReviewerIntent } from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerIntent };
export const AGENT_TOOL_NAME = "Agent";

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
}>;

export function createReviewerRoleRuntime(pi: ExtensionAPI, dependencies: ReviewerRoleDependencies, hostActions: ReviewerRoleHostActions): { activate(ctx?: ExtensionContext): Promise<ReviewerActivation> } {
  let soul: string | undefined;
  let binding: CanonicalSkillBinding<"code-review"> | undefined;
  let reader: ReviewerPinnedGitReader | undefined;
  let dispatcher: ReturnType<typeof createReviewerDispatcher> | undefined;
  let originalRequest: string | undefined;
  let expansionCaptured = false;
  let registered = false;
  let reviewScopeKeys: readonly string[] | undefined;
  let fixedBaseRevision: string | undefined;
  const ledger = createReviewerExecutionLedger();
  pi.registerFlag("ak-review-base", { description: "Fixed base revision for the pinned review target", type: "string" });
  pi.registerFlag("ak-review-scope-keys", { description: "Optional comma-separated exact class keys limiting Reviewer scope", type: "string" });

  return { async activate(ctx) {
    soul = (await dependencies.loadSoul()).trim();
    if (!soul) throw new Error("Reviewer soul is empty");
    const rawScopeKeys = pi.getFlag("ak-review-scope-keys");
    reviewScopeKeys = undefined;
    if (rawScopeKeys !== undefined) {
      if (typeof rawScopeKeys !== "string" || rawScopeKeys.length === 0) {
        throw new Error("Reviewer scope keys must be a nonempty comma-separated string");
      }
      const parsed = rawScopeKeys.split(",");
      if (parsed.some((key) => key.trim().length === 0) || new Set(parsed).size !== parsed.length) {
        throw new Error("Reviewer scope keys contain a blank or exact duplicate key");
      }
      reviewScopeKeys = parsed;
    }
    const baseRevision = pi.getFlag("ak-review-base");
    if (typeof baseRevision !== "string" || !baseRevision.trim()) throw new Error("Reviewer role requires --ak-review-base");
    fixedBaseRevision = baseRevision;
    const loaded = await dependencies.loadCanonicalSkillBinding("code-review");
    if (loaded.name !== "code-review") throw new Error("Canonical Skill binding loader returned tdd for code-review");
    binding = loaded;
    reader = await dependencies.createPinnedGitReader();

    let acceptedDispatch: AcceptedReviewerDispatch | undefined;
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
          "This runtime executes the Standards and Spec review legs for you as package-managed evidence-child sessions — that IS this runtime's implementation of the review Skill's parallel sub-agents. Do not refuse because no Agent tool appears in your tool list, and do not substitute your own sub-processes; work with the legs the runtime provides. Corrections and redos after an auditor bounce-back likewise complete only in this session with your own tools: the sole lawful model fan-out is the runtime's evidence-children legs, and no scenario self-spawns a model subprocess (pi CLI or otherwise). Evidence-leg model and thinking tier follow the seat's active order; the reviewer seat does not choose them."], parameters: reviewerOutputSchema,
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
      pi.on("before_agent_start", async (event, toolCtx) => {
        if (!expansionCaptured) {
          if (originalRequest === undefined || binding!.captureExpansion(event.prompt, originalRequest) === undefined) {
            const error = ledger.recordInfrastructureFailure(new Error("Canonical code-review Skill expansion did not match the captured request"));
            hostActions.failInfrastructure(error, toolCtx);
          }
          expansionCaptured = true;
        }
        // Soul only — caller instruction is never injected as semantic control.
        return { systemPrompt: `${event.systemPrompt}\n\n<reviewer_soul>\n${soul}\n</reviewer_soul>` };
      });
      pi.on("session_shutdown", async () => { try { await dependencies.shutdownAgent?.(); } catch (error) { throw ledger.recordInfrastructureFailure(error); } });
    }
    return Object.freeze({ dispatcher, fixedBaseRevision });
  } };
}
