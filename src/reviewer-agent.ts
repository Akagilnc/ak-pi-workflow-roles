import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isReviewerPromptText, type ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import type { AcceptedReviewerExecution } from "./reviewer-dispatch.ts";
import type { ReviewerTargetSnapshot, ReviewerWorkspaceDisposition, ReviewerFailureClassification, ReviewerUsage } from "./reviewer-execution-ledger.ts";
import { executeReviewerChild } from "./reviewer-child-executor.ts";
import { createReviewerWorkspaceOwner, type ReviewerWorkspaceFaultPoint } from "./reviewer-workspace.ts";
import { normalizeReviewerFailureDiagnostic } from "./reviewer-failure-diagnostic.ts";

type ReviewerLegRunResultCommon = Readonly<{ target: ReviewerTargetSnapshot; prompt: ReviewerPromptText; workspaceDisposition: ReviewerWorkspaceDisposition }>;
export type ReviewerSuccessfulLegRunResult = ReviewerLegRunResultCommon & Readonly<{ status: "successful"; report: string; usage: ReviewerUsage; failure?: never }>;
export type ReviewerFailedLegRunResult = ReviewerLegRunResultCommon & Readonly<{ status: "failed"; failure: ReviewerFailureClassification; diagnostic: string; cause?: unknown; report?: never; usage?: never }>;
export type ReviewerLegRunResult = ReviewerSuccessfulLegRunResult | ReviewerFailedLegRunResult;
type Envelope<L> = Readonly<{ identity: string; target: ReviewerTargetSnapshot; legs: Readonly<L> }>;
export type ReviewerDispatchRunResult = Envelope<{ standards: ReviewerLegRunResult; spec?: never }> | Envelope<{ standards: ReviewerLegRunResult; spec: ReviewerLegRunResult }>;
export type ReviewerSuccessfulDispatchRunResult = Envelope<{ standards: ReviewerSuccessfulLegRunResult; spec?: never }> | Envelope<{ standards: ReviewerSuccessfulLegRunResult; spec: ReviewerSuccessfulLegRunResult }>;
function reviewerDispatchFailureMessage(outcome: ReviewerDispatchRunResult): string {
  const diagnostics = [...new Set(
    Object.values(outcome.legs)
      .filter((leg): leg is ReviewerFailedLegRunResult => leg?.status === "failed")
      .map((leg) => leg.diagnostic.trim())
      .filter((diagnostic) => diagnostic.length > 0),
  )];
  if (diagnostics.length === 0) return "Reviewer dispatch execution failed";
  return diagnostics.length === 1 ? diagnostics[0]! : diagnostics.join("; ");
}
export class ReviewerDispatchExecutionError extends Error {
  constructor(readonly outcome: ReviewerDispatchRunResult) {
    super(reviewerDispatchFailureMessage(outcome));
    this.name = "ReviewerDispatchExecutionError";
  }
}
export type ReviewerAgentRunner = { run(dispatch: AcceptedReviewerExecution, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ReviewerSuccessfulDispatchRunResult>; shutdown(): Promise<void> };
export type ReviewerAgentFaultPoint = ReviewerWorkspaceFaultPoint;
type Dependencies = Readonly<{
  fault?(operation: ReviewerAgentFaultPoint): void;
  /** When set, child credential/config scratch is created under this parent so cleanup proofs stay process-local. */
  credentialScratchParent?: string;
  /** Package root for optional engine method-material on legs (#378). */
  packageRoot?: string;
}>;
function classify(error: unknown, signal?: AbortSignal): ReviewerFailureClassification { if (signal?.aborted) return "cancelled"; if (typeof error === "object" && error !== null && "reviewerFailure" in error) return (error as { reviewerFailure: ReviewerFailureClassification }).reviewerFailure; return "unknown"; }
function failed(error: unknown, target: ReviewerTargetSnapshot, prompt: ReviewerPromptText, signal?: AbortSignal, retained?: string): ReviewerFailedLegRunResult {
  const attached = typeof error === "object" && error !== null ? error as { targetSnapshot?: ReviewerTargetSnapshot; workspaceDisposition?: ReviewerWorkspaceDisposition } : {};
  const failure = classify(error, signal);
  const diagnostic = normalizeReviewerFailureDiagnostic(error, failure);
  return Object.freeze({
    status: "failed",
    failure,
    diagnostic,
    cause: error,
    target: attached.targetSnapshot ?? target,
    prompt,
    workspaceDisposition: retained === undefined ? attached.workspaceDisposition ?? "not-created" : { retained },
  });
}
export function createReviewerAgentRunner(dependencies: Dependencies = {}): ReviewerAgentRunner {
  const workspaceOwner = createReviewerWorkspaceOwner(dependencies.fault === undefined ? {} : { fault: dependencies.fault }); let accepted = false;
  return {
    async run(dispatch, options) {
      if (dispatch.recipe !== "reviewer-common-bundle-v1" || dispatch.legs.length < 1 || dispatch.legs.length > 2 || dispatch.legs[0]?.axis !== "standards" || (dispatch.legs.length === 2 && dispatch.legs[1]?.axis !== "spec")) throw new Error("Invalid accepted Reviewer dispatch cardinality or axes");
      if (accepted) throw new Error("Reviewer runner accepts exactly one dispatch"); accepted = true;
      for (const leg of dispatch.legs) if (!isReviewerPromptText(leg.prompt)) throw new Error("Accepted Reviewer prompt evidence mismatch");
      let batch;
      try { batch = await workspaceOwner.prepare(dispatch.targetSnapshot, dispatch.legs.map(l => l.axis), options.signal); }
      catch (error) {
        const prepared = typeof error === "object" && error !== null && "preparedWorkspaces" in error ? (error as { preparedWorkspaces?: readonly { axis: string; path: string }[] }).preparedWorkspaces ?? [] : [];
        const failedIndex = prepared.length;
        const legs = Object.fromEntries(dispatch.legs.map((leg, index) => [leg.axis, failed(error, dispatch.targetSnapshot, leg.prompt, options.signal, index < failedIndex ? prepared[index]!.path : undefined)]));
        // Siblings not yet attempted have no workspace; do not borrow the failed leg's retained path.
        for (let index = failedIndex + 1; index < dispatch.legs.length; index += 1) { const axis = dispatch.legs[index]!.axis; legs[axis] = Object.freeze({ ...legs[axis]!, workspaceDisposition: "not-created" }); }
        const target = Object.values(legs)[0]!.target; throw new ReviewerDispatchExecutionError(Object.freeze({ identity: dispatch.identity, target, legs: Object.freeze(legs) }) as ReviewerDispatchRunResult);
      }
      const settled = await Promise.allSettled(batch.workspaces.map(async workspace => {
        const leg = dispatch.legs.find(candidate => candidate.axis === workspace.axis)!;
        try {
          const child = await executeReviewerChild(workspace.path, leg, options.context, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(dependencies.credentialScratchParent === undefined
              ? {}
              : { credentialScratchParent: dependencies.credentialScratchParent }),
            ...(dependencies.packageRoot === undefined
              ? {}
              : { packageRoot: dependencies.packageRoot }),
          });
          const disposition = await workspaceOwner.dispose(workspace);
          return [leg.axis, Object.freeze({ status: "successful" as const, report: child.report, usage: child.usage, target: batch.target, prompt: child.prompt, workspaceDisposition: disposition })] as const;
        } catch (error) {
          // Failed legs retain their workspace for the durable failure evidence and caller cleanup.
          return [leg.axis, failed(error, batch.target, leg.prompt, options.signal, workspace.path)] as const;
        }
      }));
      const pairs = settled.map(item => item.status === "fulfilled" ? item.value : (() => { throw item.reason; })());
      const outcome = Object.freeze({ identity: dispatch.identity, target: batch.target, legs: Object.freeze(Object.fromEntries(pairs)) }) as ReviewerDispatchRunResult;
      if (Object.values(outcome.legs).some(leg => leg?.status === "failed")) throw new ReviewerDispatchExecutionError(outcome);
      return outcome as ReviewerSuccessfulDispatchRunResult;
    },
    shutdown: () => workspaceOwner.shutdown(),
  };
}
