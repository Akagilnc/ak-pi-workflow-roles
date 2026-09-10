/**
 * #836 删 8: Reviewer no longer code-compiles or spawns axis children.
 * Parent seat invokes the packaged code-review skill (skill-owned subagent).
 * This runner only acknowledges an accepted dispatch identity without child I/O.
 */
import type { HostContext } from "./host-contracts.ts";
import type { AcceptedReviewerExecution } from "./reviewer-dispatch.ts";
import type { ReviewerTargetSnapshot, ReviewerWorkspaceDisposition, ReviewerFailureClassification, ReviewerUsage } from "./reviewer-execution-ledger.ts";
import { isReviewerPromptText, type ReviewerPromptText } from "./reviewer-prompt-identity.ts";

type ReviewerLegRunResultCommon = Readonly<{ target: ReviewerTargetSnapshot; prompt: ReviewerPromptText; workspaceDisposition: ReviewerWorkspaceDisposition }>;
export type ReviewerSuccessfulLegRunResult = ReviewerLegRunResultCommon & Readonly<{ status: "successful"; report: unknown; usage: ReviewerUsage; failure?: never }>;
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

export type ReviewerDispatchRunOptions = Readonly<{
  context: HostContext;
  signal?: AbortSignal;
  getFlag?: (name: string) => boolean | string | undefined;
}>;

export type ReviewerAgentRunner = {
  run(dispatch: AcceptedReviewerExecution, options: ReviewerDispatchRunOptions): Promise<ReviewerSuccessfulDispatchRunResult>;
  shutdown(): Promise<void>;
};

export type ReviewerAgentFaultPoint = "prepare" | "dispose" | "shutdown";

type Dependencies = Readonly<{
  fault?(operation: ReviewerAgentFaultPoint): void;
  credentialScratchParent?: string;
  packageRoot?: string;
}>;

/** No child spawn, no workspace, no executeReviewerChild (#836 删 8). */
export function createReviewerAgentRunner(_dependencies: Dependencies = {}): ReviewerAgentRunner {
  let accepted = false;
  return {
    async run(dispatch, _options) {
      if (
        dispatch.recipe !== "reviewer-common-bundle-v1"
        || dispatch.legs.length < 1
        || dispatch.legs.length > 2
        || dispatch.legs[0]?.axis !== "standards"
        || (dispatch.legs.length === 2 && dispatch.legs[1]?.axis !== "spec")
      ) {
        throw new Error("Invalid accepted Reviewer dispatch cardinality or axes");
      }
      if (accepted) throw new Error("Reviewer runner accepts exactly one dispatch");
      accepted = true;
      for (const leg of dispatch.legs) {
        if (!isReviewerPromptText(leg.prompt)) throw new Error("Accepted Reviewer prompt evidence mismatch");
      }
      const emptyUsage: ReviewerUsage = Object.freeze({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
      });
      const pairs = dispatch.legs.map((leg) => [
        leg.axis,
        Object.freeze({
          status: "successful" as const,
          // Parent code-review skill owns real axis work; code does not compile children.
          report: Object.freeze({ deferredToParentCodeReviewSkill: true }),
          usage: emptyUsage,
          target: dispatch.targetSnapshot,
          prompt: leg.prompt,
          workspaceDisposition: "not-created" as const,
        }),
      ] as const);
      return Object.freeze({
        identity: dispatch.identity,
        target: dispatch.targetSnapshot,
        legs: Object.freeze(Object.fromEntries(pairs)),
      }) as ReviewerSuccessfulDispatchRunResult;
    },
    async shutdown() {
      // No workspace owner to shut down.
    },
  };
}

export function createPerDispatchReviewerAgent(dependencies: Dependencies = {}): ReviewerAgentRunner {
  const active = new Set<ReviewerAgentRunner>();
  return {
    async run(dispatch, options) {
      const runner = createReviewerAgentRunner(dependencies);
      active.add(runner);
      try {
        return await runner.run(dispatch, options);
      } finally {
        active.delete(runner);
        await runner.shutdown();
      }
    },
    async shutdown() {
      const runners = [...active];
      active.clear();
      await Promise.all(runners.map((runner) => runner.shutdown()));
    },
  };
}
