import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { immutableReviewerPin } from "./reviewer-pinned-git.js";
export { createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
import { isReviewerPromptText, sameReviewerPromptText } from "./reviewer-prompt-identity.js";
import { sha256Hex } from "./sha256.js";
import { constructReviewerDispatch, discoverReviewerSpecAuthority, } from "./reviewer-construction.js";
export { discoverReviewerSpecAuthority, } from "./reviewer-construction.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
export { sha256Hex } from "./sha256.js";
export { isReviewerPromptText as isReviewerPromptIdentity, sameReviewerPromptText as sameReviewerPromptIdentity } from "./reviewer-prompt-identity.js";
const LOCAL_SPEC_ROOTS = ["docs", "specs", ".scratch"];
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
 * Production owner wiring for code-review Skill step 2 discovery.
 * Gathers fixed-range commit messages, feature tokens, and local Spec candidate paths,
 * then delegates the available/missing judgement to discoverReviewerSpecAuthority.
 */
export async function resolveReviewerSpecAuthorityDiscovery(input) {
    if (input.authorityRefs.length > 0) {
        return discoverReviewerSpecAuthority({
            authorityRefs: input.authorityRefs,
            commitMessages: [],
            localSpecCandidatePaths: [],
            featureTokens: [],
        });
    }
    const [commitMessages, featureTokens, localSpecCandidatePaths] = await Promise.all([
        input.reader.rangeCommitMessages(input.range),
        input.reader.featureTokens(),
        listLocalSpecCandidatePaths(input.reader.pin.repositoryRoot),
    ]);
    return discoverReviewerSpecAuthority({
        authorityRefs: input.authorityRefs,
        commitMessages,
        localSpecCandidatePaths,
        featureTokens,
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
                const specAuthorityDiscovery = await resolveReviewerSpecAuthorityDiscovery({
                    authorityRefs,
                    reader: d.reader,
                    range,
                });
                dispatch = constructReviewerDispatch({
                    identity,
                    canonicalSkill: d.canonicalSkill,
                    target,
                    range,
                    ...(d.reviewScopeKeys === undefined ? {} : { reviewScopeKeys: d.reviewScopeKeys }),
                    authorityRefs,
                    specAuthorityDiscovery,
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
