import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { immutableReviewerPin } from "./reviewer-pinned-git.js";
export { createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
import { isReviewerPromptText, sameReviewerPromptText } from "./reviewer-prompt-identity.js";
import { sha256Hex } from "./sha256.js";
import { constructReviewerDispatch } from "./reviewer-construction.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
export { sha256Hex } from "./sha256.js";
export { isReviewerPromptText as isReviewerPromptIdentity, sameReviewerPromptText as sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
export const REVIEWER_PREFLIGHT_VIOLATIONS = ["base-invalid", "range-invalid", "prompt-identity-invalid", "target-drift"];
export class ReviewerPreflightError extends Error {
    code;
    diagnostic;
    constructor(code, diagnostic = `${code} constraint failed`) {
        super(`${code}: ${diagnostic}`);
        this.code = code;
        this.diagnostic = diagnostic;
    }
}
export function toReviewerExecution(dispatch) {
    return Object.freeze({
        identity: dispatch.identity,
        recipe: dispatch.recipe,
        targetSnapshot: immutableReviewerPin(dispatch.targetSnapshot),
        legs: Object.freeze(dispatch.legs.map((l) => Object.freeze({ axis: l.axis, prompt: l.prompt }))),
    });
}
const preflight = (error) => {
    if (error instanceof ReviewerPreflightError)
        return error;
    if (error instanceof ReviewerCorrectablePreflightError) {
        return new ReviewerPreflightError(error.code, error.diagnostic);
    }
    return undefined;
};
export function createReviewerDispatcher(d) {
    const target = immutableReviewerPin(d.reader.pin);
    let started = false;
    return Object.freeze({
        async dispatch(baseRevision, invocation) {
            if (started)
                throw new Error("Reviewer fixed dispatch can start exactly once");
            const identity = sha256Hex(JSON.stringify({
                baseRevision,
                target: target.targetHead,
                canonicalSkill: sha256Hex(d.canonicalSkill),
            }));
            let dispatch;
            try {
                const base = await d.reader.resolve(baseRevision);
                const range = await d.reader.range(base);
                dispatch = constructReviewerDispatch({
                    identity,
                    canonicalSkill: d.canonicalSkill,
                    target,
                    range,
                    ...(d.reviewScopeKeys === undefined ? {} : { reviewScopeKeys: d.reviewScopeKeys }),
                });
                if (!sameReviewerPinnedTarget(await d.reader.snapshot(), target)) {
                    throw new ReviewerPreflightError("target-drift", "pinned target snapshot changed before child execution");
                }
            }
            catch (error) {
                const p = preflight(error);
                if (!p)
                    throw error;
                d.decisionEvidence?.(Object.freeze({ disposition: "rejected", identity, violations: Object.freeze([p.code]), started: false }));
                return Object.freeze({ status: "rejected", identity, violations: Object.freeze([p.code]), diagnostic: p.diagnostic });
            }
            started = true;
            d.decisionEvidence?.(Object.freeze({ disposition: "accepted", identity, dispatch }));
            const results = await d.run(toReviewerExecution(dispatch), invocation);
            return Object.freeze({ status: "accepted", dispatch, results });
        },
    });
}
export { isReviewerPromptText, sameReviewerPromptText };
