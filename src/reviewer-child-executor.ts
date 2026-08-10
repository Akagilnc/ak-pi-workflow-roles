import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeEvidenceChild, type EvidenceChildFaultPoint } from "./evidence-child-executor.ts";
import type { AcceptedReviewerLeg } from "./reviewer-dispatch.ts";

export type ReviewerExecutorFaultPoint = EvidenceChildFaultPoint;
export type ReviewerChildExecuteOptions = Readonly<{
  signal?: AbortSignal;
  fault?(operation: ReviewerExecutorFaultPoint): void;
  credentialScratchParent?: string;
}>;

/**
 * Single conversion at the Reviewer adapter boundary: shared child classifications
 * become Reviewer failure classifications without a second error taxonomy.
 */
export function projectSharedChildFailure(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "evidenceChildFailure" in error) {
    const classification = (error as { evidenceChildFailure?: unknown }).evidenceChildFailure;
    if (classification === "provider" || classification === "child") {
      Object.assign(error, { reviewerFailure: classification });
    }
  }
  return error;
}

/** Reviewer policy adapter over the shared evidence-child lifecycle seam. */
export async function executeReviewerChild(workspace: string, leg: AcceptedReviewerLeg, context: ExtensionContext, options: ReviewerChildExecuteOptions = {}) {
  try {
    return await executeEvidenceChild(workspace, leg.prompt, context, options);
  } catch (error) {
    throw projectSharedChildFailure(error);
  }
}
