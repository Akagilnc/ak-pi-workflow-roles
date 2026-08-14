import { executeEvidenceChild } from "./evidence-child-executor.js";
/**
 * Single conversion at the Reviewer adapter boundary: shared child classifications
 * become Reviewer failure classifications without a second error taxonomy.
 */
export function projectSharedChildFailure(error) {
    if (typeof error === "object" && error !== null && "evidenceChildFailure" in error) {
        const classification = error.evidenceChildFailure;
        if (classification === "provider" || classification === "child" || classification === "unknown") {
            Object.assign(error, { reviewerFailure: classification });
        }
    }
    return error;
}
/** Reviewer policy adapter over the shared evidence-child lifecycle seam. */
export async function executeReviewerChild(workspace, leg, context, options = {}) {
    try {
        return await executeEvidenceChild(workspace, leg.prompt, context, options);
    }
    catch (error) {
        throw projectSharedChildFailure(error);
    }
}
