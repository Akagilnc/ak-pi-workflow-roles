import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.js";
import { branchNamesAtPinnedHead, immutableReviewerPin } from "./reviewer-pinned-git.js";
export { branchNamesAtPinnedHead, createReviewerPinnedGitReader, immutableReviewerPin } from "./reviewer-pinned-git.js";
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
/** Branch token ticket capture: (fix|feat|docs|audit|test)/issue-(\d+)- (#343). */
const BRANCH_ISSUE_TOKEN = /(?:^|\/)((?:fix|feat|docs|audit|test)\/issue-(\d+)-)/;
/** First #N in a commit subject (positive integer). */
const COMMIT_TICKET_TOKEN = /#([1-9]\d*)/;
/** docs/adr paths referenced inside an issue body. */
const ADR_PATH_IN_BODY = /docs\/adr\/[A-Za-z0-9][A-Za-z0-9._/-]*\.md/g;
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
 * Shared capture/number → positive-integer → frozen candidate conversion.
 * Single true source for branch/commit (and typed) ticket candidate materialization.
 */
function ticketCandidateFromRaw(source, raw) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n < 1)
        return undefined;
    return Object.freeze({ source, ticketNumber: n });
}
/**
 * Resolve ticket number with unique priority (#343):
 * typed ticketNumber → branch token → newest commit message first #N.
 * High-priority hit is adopted; lower sources that also yield a number are abandoned candidates.
 */
export function resolveReviewerTicketNumber(input) {
    const typed = ticketCandidateFromRaw("typed-ticket-number", input.ticketNumber);
    let branch;
    for (const name of input.branchNames) {
        const match = BRANCH_ISSUE_TOKEN.exec(name);
        if (match) {
            branch = ticketCandidateFromRaw("branch-token", match[2]);
            if (branch !== undefined)
                break;
        }
    }
    let commit;
    const newest = input.commitMessagesNewestFirst[0];
    if (newest !== undefined) {
        const match = COMMIT_TICKET_TOKEN.exec(newest);
        if (match) {
            commit = ticketCandidateFromRaw("commit-message", match[1]);
        }
    }
    if (typed !== undefined) {
        const abandoned = [branch, commit].filter((c) => c !== undefined);
        return Object.freeze({ adopted: typed, abandoned: Object.freeze(abandoned) });
    }
    if (branch !== undefined) {
        const abandoned = commit === undefined ? Object.freeze([]) : Object.freeze([commit]);
        return Object.freeze({ adopted: branch, abandoned });
    }
    if (commit !== undefined) {
        return Object.freeze({ adopted: commit, abandoned: Object.freeze([]) });
    }
    return undefined;
}
/** Extract unique docs/adr/*.md paths referenced by issue body text (order of first appearance). */
export function extractReferencedAdrPaths(issueBody) {
    const seen = new Set();
    const paths = [];
    for (const match of issueBody.matchAll(ADR_PATH_IN_BODY)) {
        const path = match[0];
        if (seen.has(path))
            continue;
        seen.add(path);
        paths.push(path);
    }
    return Object.freeze(paths);
}
/** Optional AbortSignal carried on the dispatch invocation bag (same shape runDispatch already reads). */
function optionalInvocationSignal(invocation) {
    if (typeof invocation !== "object" || invocation === null)
        return undefined;
    const signal = invocation.signal;
    return signal instanceof AbortSignal ? signal : undefined;
}
/**
 * Unique production owner of code-review Skill step 2 Spec discovery (#343).
 * Primary: self-fetch latest issue by ticket number (typed → branch token → commit #N).
 * Degradation (unique order): self-fetch fail → supplied authorityRefs → local path match → missing.
 * Prompt/admitted-request prose is never Spec material.
 * Only confirmed absence yields missing; non-absence Git/I-O failures keep true cause for preflight.
 * Construction builds Standards/Spec solely from this product.
 */
export async function discoverReviewerSpecAuthority(input) {
    // Path-matching tokens (heads/tags/remotes) stay separate from branch-ticket provenance.
    const featureTokens = await input.reader.featureTokens();
    const commitMessages = input.baseCommit === undefined
        ? Object.freeze([])
        : await input.reader.commitMessagesNewestFirst(input.baseCommit);
    const ticketResolution = resolveReviewerTicketNumber({
        ...(input.ticketNumber === undefined ? {} : { ticketNumber: input.ticketNumber }),
        // Branch ticket source: real heads/remotes at targetHead only — never tags via featureTokens.
        branchNames: branchNamesAtPinnedHead(input.reader.pin),
        commitMessagesNewestFirst: commitMessages,
    });
    // ① Primary: self-fetch latest issue + referenced docs/adr via injected capability only.
    if (ticketResolution !== undefined) {
        const origin = await input.reader.originRepository();
        if (origin !== undefined && input.fetchIssue !== undefined) {
            const issue = await input.fetchIssue({
                owner: origin.owner,
                repo: origin.repo,
                ticketNumber: ticketResolution.adopted.ticketNumber,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            if (issue !== undefined) {
                const adrPaths = extractReferencedAdrPaths(issue.body);
                const adrs = [];
                for (const path of adrPaths) {
                    const body = await input.reader.readPinnedText(path);
                    if (body === undefined) {
                        adrs.push(Object.freeze({ path, status: "missing" }));
                    }
                    else {
                        adrs.push(Object.freeze({ path, status: "present", body }));
                    }
                }
                const issueRef = `https://github.com/${origin.owner}/${origin.repo}/issues/${ticketResolution.adopted.ticketNumber}`;
                const presentAdrRefs = adrs
                    .filter((a) => a.status === "present")
                    .map((a) => a.path);
                const fetched = Object.freeze({
                    issueRef,
                    owner: origin.owner,
                    repo: origin.repo,
                    ticketNumber: ticketResolution.adopted.ticketNumber,
                    adopted: ticketResolution.adopted,
                    abandoned: ticketResolution.abandoned,
                    issueBody: issue.body,
                    adrs: Object.freeze(adrs),
                });
                return Object.freeze({
                    status: "available",
                    refs: Object.freeze([issueRef, ...presentAdrRefs]),
                    fetched,
                });
            }
        }
    }
    // ② Degrade: explicit --authority-ref (human intent before local heuristics).
    if (input.authorityRefs.length > 0) {
        return Object.freeze({
            status: "available",
            refs: Object.freeze([...input.authorityRefs]),
        });
    }
    // ③ Degrade: matching pinned-target docs/specs/.scratch paths via branch feature tokens.
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
                const signal = optionalInvocationSignal(invocation);
                const specAuthority = await discoverReviewerSpecAuthority({
                    authorityRefs,
                    reader: d.reader,
                    baseCommit: base,
                    ...(d.ticketNumber === undefined ? {} : { ticketNumber: d.ticketNumber }),
                    ...(d.fetchIssue === undefined ? {} : { fetchIssue: d.fetchIssue }),
                    ...(signal === undefined ? {} : { signal }),
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
