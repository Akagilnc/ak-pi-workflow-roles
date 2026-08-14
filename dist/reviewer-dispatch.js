import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { immutableReviewerPin } from "./reviewer-pinned-git.js";
export { createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
import { isReviewerPromptText, sameReviewerPromptText } from "./reviewer-prompt-identity.js";
import { sha256Hex } from "./sha256.js";
import { constructReviewerDispatch, } from "./reviewer-construction.js";
export {} from "./reviewer-construction.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
export { sha256Hex } from "./sha256.js";
export { isReviewerPromptText as isReviewerPromptIdentity, sameReviewerPromptText as sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
const GENERIC_FEATURE_TOKENS = new Set(["", "head", "main", "master", "trunk", "develop", "development"]);
/** Conventional branch shells that must not hide the feature token (feat/login → login). */
const BRANCH_SHELL_PREFIX = /^(?:feat|feature|fix|bugfix|hotfix|chore|docs|refactor)-/;
function normalizeFeatureToken(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/** Expand one branch/ref name into matchable tokens, stripping conventional shells. */
function expandFeatureTokens(raw) {
    const normalized = normalizeFeatureToken(raw);
    if (normalized.length === 0)
        return Object.freeze([]);
    const tokens = new Set([normalized]);
    const stripped = normalized.replace(BRANCH_SHELL_PREFIX, "");
    if (stripped.length > 0 && stripped !== normalized)
        tokens.add(stripped);
    return Object.freeze([...tokens]);
}
/**
 * Unique production owner of code-review Skill step 2 Spec discovery.
 * Directly yields durable refs Spec child can read, or confirmed missing.
 * - Supplied authorityRefs ⇒ available with those refs as material.
 * - Matching pinned-target docs/specs/.scratch paths ⇒ available with those paths as material.
 * - Commit message bare #N without durable source ⇒ missing (not available).
 * Only confirmed absence yields missing; other Git/I-O failures keep true cause for preflight.
 * Construction builds Standards/Spec solely from this product.
 */
export async function discoverReviewerSpecAuthority(input) {
    if (input.authorityRefs.length > 0) {
        return Object.freeze({
            status: "available",
            refs: Object.freeze([...input.authorityRefs]),
        });
    }
    const featureTokens = await input.reader.featureTokens();
    const tokens = [
        ...new Set(featureTokens
            .flatMap((raw) => expandFeatureTokens(raw))
            .filter((token) => token.length >= 3 && !GENERIC_FEATURE_TOKENS.has(token))),
    ];
    if (tokens.length === 0) {
        return Object.freeze({ status: "missing" });
    }
    // Pinned target tree only — Spec child cannot read live-worktree or gitignored paths.
    const candidates = await input.reader.listSpecCandidatePaths();
    const matched = candidates.filter((relativePath) => {
        const normalizedPath = normalizeFeatureToken(relativePath);
        return tokens.some((token) => normalizedPath.includes(token));
    });
    if (matched.length === 0) {
        return Object.freeze({ status: "missing" });
    }
    return Object.freeze({
        status: "available",
        refs: Object.freeze(matched),
    });
}
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
                const authorityRefs = Object.freeze([...(d.authorityRefs ?? [])]);
                const specAuthority = await discoverReviewerSpecAuthority({
                    authorityRefs,
                    reader: d.reader,
                });
                dispatch = constructReviewerDispatch({
                    identity,
                    canonicalSkill: d.canonicalSkill,
                    target,
                    range,
                    ...(d.reviewScopeKeys === undefined ? {} : { reviewScopeKeys: d.reviewScopeKeys }),
                    specAuthority,
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
