import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isReviewerPromptIdentity, type ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import type { AcceptedReviewerExecution, ReviewerPrerequisiteOperation } from "./reviewer-dispatch.ts";
import type { MaterializedBundleEvidenceV1 } from "./reviewer-bundle-materializer.ts";
import type { ReviewerTargetSnapshot, ReviewerWorkspaceDisposition, ReviewerFailureClassification, ReviewerUsage } from "./reviewer-execution-ledger.ts";
import { executeReviewerChild, type ReviewerExecutorFaultPoint } from "./reviewer-child-executor.ts";
import { createReviewerWorkspaceOwner, type ReviewerWorkspaceFaultPoint } from "./reviewer-workspace.ts";

const RUNNER_PREREQUISITES = ["runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot"] as const satisfies readonly ReviewerPrerequisiteOperation[];
export type ReviewerSuccessfulLegRunResult = Readonly<{ status: "successful"; report: string; usage: ReviewerUsage; target: ReviewerTargetSnapshot; prompt: ReviewerPromptIdentity; workspaceDisposition: ReviewerWorkspaceDisposition; runtimeConstructionEvidence?: MaterializedBundleEvidenceV1 }>;
export type ReviewerFailedLegRunResult = Readonly<{ status: "failed"; failure: ReviewerFailureClassification; target: ReviewerTargetSnapshot; prompt: ReviewerPromptIdentity; workspaceDisposition: ReviewerWorkspaceDisposition; runtimeConstructionEvidence?: MaterializedBundleEvidenceV1 }>;
export type ReviewerLegRunResult = ReviewerSuccessfulLegRunResult | ReviewerFailedLegRunResult;
type Envelope<L> = Readonly<{ identity: string; target: ReviewerTargetSnapshot; legs: Readonly<L> }>;
export type ReviewerDispatchRunResult = Envelope<{ standards: ReviewerLegRunResult; spec?: never }> | Envelope<{ standards: ReviewerLegRunResult; spec: ReviewerLegRunResult }>;
export type ReviewerSuccessfulDispatchRunResult = Envelope<{ standards: ReviewerSuccessfulLegRunResult; spec?: never }> | Envelope<{ standards: ReviewerSuccessfulLegRunResult; spec: ReviewerSuccessfulLegRunResult }>;
export class ReviewerDispatchExecutionError extends Error { constructor(readonly outcome: ReviewerDispatchRunResult) { super("Reviewer dispatch execution failed"); this.name = "ReviewerDispatchExecutionError"; } }
export type ReviewerAgentRunner = { run(dispatch: AcceptedReviewerExecution, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ReviewerSuccessfulDispatchRunResult>; shutdown(): Promise<void> };
export type ReviewerAgentFaultPoint = ReviewerWorkspaceFaultPoint | ReviewerExecutorFaultPoint;
type Dependencies = Readonly<{ fault?(operation: ReviewerAgentFaultPoint): void }>;
function classify(error: unknown, signal?: AbortSignal): ReviewerFailureClassification { if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled"; if (typeof error === "object" && error !== null && "reviewerFailure" in error) return (error as { reviewerFailure: ReviewerFailureClassification }).reviewerFailure; return "unknown"; }
function failed(error: unknown, target: ReviewerTargetSnapshot, prompt: ReviewerPromptIdentity, signal?: AbortSignal, retained?: string, evidence?: MaterializedBundleEvidenceV1): ReviewerFailedLegRunResult { const attached = typeof error === "object" && error !== null ? error as { targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition } : {}; return Object.freeze({ status: "failed", failure: classify(error, signal), target: attached.targetSnapshot ?? target, prompt, workspaceDisposition: retained === undefined ? attached.workspaceDisposition ?? "not-created" : { retained }, ...(evidence === undefined ? {} : { runtimeConstructionEvidence: evidence }) }); }
export function createReviewerAgentRunner(dependencies: Dependencies = {}): ReviewerAgentRunner {
  const workspaceOwner = createReviewerWorkspaceOwner(dependencies.fault === undefined ? {} : { fault: dependencies.fault }); let accepted = false;
  return {
    async run(dispatch, options) {
      if (dispatch.recipe !== "reviewer-common-bundle-v1" || dispatch.legs.length < 1 || dispatch.legs.length > 2 || dispatch.legs[0]?.axis !== "standards" || (dispatch.legs.length === 2 && dispatch.legs[1]?.axis !== "spec")) throw new Error("Invalid accepted Reviewer dispatch cardinality or axes");
      if (accepted) throw new Error("Reviewer runner accepts exactly one dispatch"); accepted = true;
      for (const leg of dispatch.legs) if (!isReviewerPromptIdentity(leg.prompt)) throw new Error("Accepted Reviewer prompt evidence mismatch");
      for (const operation of RUNNER_PREREQUISITES) if (!dispatch.prerequisiteOperations.includes(operation)) throw new Error(`Missing accepted runner prerequisite: ${operation}`);
      let batch;
      try { batch = await workspaceOwner.prepare(dispatch.targetSnapshot, dispatch.legs.map(l => l.axis), dispatch.bundle, options.signal); }
      catch (error) {
        const prepared = typeof error === "object" && error !== null && "preparedWorkspaces" in error ? (error as { preparedWorkspaces?: readonly { axis: string; path: string; evidence: MaterializedBundleEvidenceV1 }[] }).preparedWorkspaces ?? [] : [];
        const failedIndex = prepared.length;
        const legs = Object.fromEntries(dispatch.legs.map((leg, index) => [leg.axis, failed(error, dispatch.targetSnapshot, leg.prompt, options.signal, index < failedIndex ? prepared[index]!.path : undefined, index < failedIndex ? prepared[index]!.evidence : undefined)]));
        // Siblings not yet attempted have no workspace; do not borrow the failed leg's retained path.
        for (let index = failedIndex + 1; index < dispatch.legs.length; index += 1) { const axis = dispatch.legs[index]!.axis; legs[axis] = Object.freeze({ ...legs[axis]!, workspaceDisposition: "not-created" }); }
        const target = Object.values(legs)[0]!.target; throw new ReviewerDispatchExecutionError(Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(legs) }) as ReviewerDispatchRunResult);
      }
      const settled = await Promise.allSettled(batch.workspaces.map(async workspace => {
        const leg = dispatch.legs.find(candidate => candidate.axis === workspace.axis)!;
        try { const child = await executeReviewerChild(workspace.path, leg, options.context, options.signal, dependencies.fault); const disposition = await workspaceOwner.dispose(workspace); return [leg.axis, Object.freeze({ status: "successful" as const, report: child.report, usage: child.usage, target: batch.target, prompt: child.prompt, workspaceDisposition: disposition, runtimeConstructionEvidence: workspace.evidence })] as const; }
        catch (error) { return [leg.axis, failed(error, batch.target, leg.prompt, options.signal, workspace.path, workspace.evidence)] as const; }
      }));
      const pairs = settled.map(item => item.status === "fulfilled" ? item.value : (() => { throw item.reason; })());
      const outcome = Object.freeze({ identity: dispatch.identity, target: batch.target, legs: Object.freeze(Object.fromEntries(pairs)) }) as ReviewerDispatchRunResult;
      if (Object.values(outcome.legs).some(leg => leg?.status === "failed")) throw new ReviewerDispatchExecutionError(outcome);
      return outcome as ReviewerSuccessfulDispatchRunResult;
    },
    shutdown: () => workspaceOwner.shutdown(),
  };
}
