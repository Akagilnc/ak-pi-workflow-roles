import { executeEvidenceChild } from "./evidence-child-executor.js";
/** Reviewer policy adapter over the shared evidence-child lifecycle seam. */
export async function executeReviewerChild(workspace, leg, context, options = {}) {
    try {
        return await executeEvidenceChild(workspace, leg.prompt, context, options);
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "evidenceChildFailure" in error) {
            const classification = error.evidenceChildFailure;
            if (classification === "provider" || classification === "child") {
                Object.assign(error, { reviewerFailure: classification });
            }
        }
        throw error;
    }
}
