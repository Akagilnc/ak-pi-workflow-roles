import { executeEvidenceChild } from "./evidence-child-executor.js";
/** Reviewer policy adapter over the shared evidence-child lifecycle seam. */
export function executeReviewerChild(workspace, leg, context, options = {}) {
    return executeEvidenceChild(workspace, leg.prompt, context, options);
}
