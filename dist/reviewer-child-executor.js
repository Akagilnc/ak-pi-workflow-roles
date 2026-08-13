import { executeEvidenceChild } from "./evidence-child-executor.js";
function projectSharedChildFailure(error) {
  if (typeof error === "object" && error !== null && "evidenceChildFailure" in error) {
    const classification = error.evidenceChildFailure;
    if (classification === "provider" || classification === "child" || classification === "unknown") {
      Object.assign(error, { reviewerFailure: classification });
    }
  }
  return error;
}
async function executeReviewerChild(workspace, leg, context, options = {}) {
  try {
    return await executeEvidenceChild(workspace, leg.prompt, context, options);
  } catch (error) {
    throw projectSharedChildFailure(error);
  }
}
export {
  executeReviewerChild,
  projectSharedChildFailure
};
