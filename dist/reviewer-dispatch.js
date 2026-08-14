import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
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
const LOCAL_SPEC_ROOTS = ["docs", "specs", ".scratch"];
const GENERIC_FEATURE_TOKENS = new Set(["", "head", "main", "master", "trunk", "develop", "development"]);
function normalizeFeatureToken(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function listLocalSpecCandidatePaths(repositoryRoot) {
    const found = [];
    const walk = async (absoluteDir) => {
        let entries;
        try {
            entries = await readdir(absoluteDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const absolutePath = join(absoluteDir, entry.name);
            if (entry.isDirectory()) {
                await walk(absolutePath);
                continue;
            }
            if (entry.isFile()) {
                found.push(relative(repositoryRoot, absolutePath).split("\\").join("/"));
            }
        }
    };
    for (const root of LOCAL_SPEC_ROOTS) {
        await walk(join(repositoryRoot, root));
    }
    return Object.freeze(found);
}
/**
 * Unique production owner of code-review Skill step 2 Spec discovery.
 * Directly yields durable refs Spec child can read, or confirmed missing.
 * - Supplied authorityRefs ⇒ available with those refs as material.
 * - Matching local docs/specs/.scratch paths ⇒ available with those paths as material.
 * - Commit message bare #N without durable source ⇒ missing (not available).
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
    const tokens = featureTokens
        .map(normalizeFeatureToken)
        .filter((token) => token.length >= 3 && !GENERIC_FEATURE_TOKENS.has(token));
    if (tokens.length === 0) {
        return Object.freeze({ status: "missing" });
    }
    const candidates = await listLocalSpecCandidatePaths(input.reader.pin.repositoryRoot);
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
