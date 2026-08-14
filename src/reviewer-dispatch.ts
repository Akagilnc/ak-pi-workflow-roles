import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import { immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
export { createReviewerPinnedGitReader, immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
import { isReviewerPromptText, sameReviewerPromptText, type ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import { sha256Hex } from "./sha256.ts";
import {
  constructReviewerDispatch,
  type ConstructedReviewerDispatch,
  type ReviewerSpecAuthorityDiscovery,
} from "./reviewer-construction.ts";
export {
  type ReviewerSpecAuthorityDiscovery,
  type ReviewerSpecDisposition,
} from "./reviewer-construction.ts";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.ts";
export { sha256Hex } from "./sha256.ts";
export { isReviewerPromptText as isReviewerPromptIdentity, sameReviewerPromptText as sameReviewerPromptIdentity, type ReviewerPromptText as ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

const GENERIC_FEATURE_TOKENS = new Set(["", "head", "main", "master", "trunk", "develop", "development"]);
/** Conventional branch shells that must not hide the feature token (feat/login → login). */
const BRANCH_SHELL_PREFIX = /^(?:feat|feature|fix|bugfix|hotfix|chore|docs|refactor)-/;

function normalizeFeatureToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Expand one branch/ref name into matchable tokens, stripping conventional shells. */
function expandFeatureTokens(raw: string): readonly string[] {
  const normalized = normalizeFeatureToken(raw);
  if (normalized.length === 0) return Object.freeze([]);
  const tokens = new Set<string>([normalized]);
  const stripped = normalized.replace(BRANCH_SHELL_PREFIX, "");
  if (stripped.length > 0 && stripped !== normalized) tokens.add(stripped);
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
export async function discoverReviewerSpecAuthority(input: {
  authorityRefs: readonly string[];
  reader: ReviewerPinnedGitReader;
}): Promise<ReviewerSpecAuthorityDiscovery> {
  if (input.authorityRefs.length > 0) {
    return Object.freeze({
      status: "available" as const,
      refs: Object.freeze([...input.authorityRefs]),
    });
  }
  const featureTokens = await input.reader.featureTokens();
  const tokens = [
    ...new Set(
      featureTokens
        .flatMap((raw) => expandFeatureTokens(raw))
        .filter((token) => token.length >= 3 && !GENERIC_FEATURE_TOKENS.has(token)),
    ),
  ];
  if (tokens.length === 0) {
    return Object.freeze({ status: "missing" as const });
  }
  // Pinned target tree only — Spec child cannot read live-worktree or gitignored paths.
  const candidates = await input.reader.listSpecCandidatePaths();
  const matched = candidates.filter((relativePath) => {
    const normalizedPath = normalizeFeatureToken(relativePath);
    return tokens.some((token) => normalizedPath.includes(token));
  });
  if (matched.length === 0) {
    return Object.freeze({ status: "missing" as const });
  }
  return Object.freeze({
    status: "available" as const,
    refs: Object.freeze(matched),
  });
}

export type AcceptedReviewerLeg = ConstructedReviewerDispatch["legs"][number];
export type AcceptedReviewerDispatch = ConstructedReviewerDispatch;
export type AcceptedReviewerExecution = Readonly<{
  identity: string;
  recipe: "reviewer-common-bundle-v1";
  targetSnapshot: ReviewerPinnedTarget;
  legs: readonly AcceptedReviewerLeg[];
}>;
export const REVIEWER_PREFLIGHT_VIOLATIONS = ["base-invalid", "range-invalid", "prompt-identity-invalid", "target-drift"] as const;
export type ReviewerPreflightViolation = (typeof REVIEWER_PREFLIGHT_VIOLATIONS)[number];
export type ReviewerDispatchResult =
  | Readonly<{ status: "rejected"; identity: string; violations: readonly ReviewerPreflightViolation[]; diagnostic: string }>
  | Readonly<{ status: "accepted"; dispatch: AcceptedReviewerDispatch; results: unknown }>;
export type ReviewerDecisionEvidence =
  | Readonly<{ disposition: "rejected"; identity: string; violations: readonly ReviewerPreflightViolation[]; started: false }>
  | Readonly<{ disposition: "accepted"; identity: string; dispatch: AcceptedReviewerDispatch }>;
type DispatcherDependencies = Readonly<{
  canonicalSkill: string;
  reader: ReviewerPinnedGitReader;
  reviewScopeKeys?: readonly string[];
  /** Durable authority references preserved unchanged into Spec-leg construction only. */
  authorityRefs?: readonly string[];
  run(execution: AcceptedReviewerExecution, invocation: unknown): Promise<unknown>;
  decisionEvidence?(decision: ReviewerDecisionEvidence): void;
}>;
export class ReviewerPreflightError extends Error {
  constructor(readonly code: ReviewerPreflightViolation, readonly diagnostic = `${code} constraint failed`) {
    super(`${code}: ${diagnostic}`);
  }
}
export function toReviewerExecution(dispatch: AcceptedReviewerDispatch): AcceptedReviewerExecution {
  return Object.freeze({
    identity: dispatch.identity,
    recipe: dispatch.recipe,
    targetSnapshot: immutableReviewerPin(dispatch.targetSnapshot),
    legs: Object.freeze(dispatch.legs.map((l) => Object.freeze({ axis: l.axis, prompt: l.prompt }))),
  });
}
const preflight = (error: unknown): ReviewerPreflightError | undefined => {
  if (error instanceof ReviewerPreflightError) return error;
  if (error instanceof ReviewerCorrectablePreflightError) {
    return new ReviewerPreflightError(error.code as ReviewerPreflightViolation, error.diagnostic);
  }
  return undefined;
};
export function createReviewerDispatcher(d: DispatcherDependencies) {
  const target = immutableReviewerPin(d.reader.pin);
  let started = false;
  return Object.freeze({
    async dispatch(baseRevision: string, invocation?: unknown): Promise<ReviewerDispatchResult> {
      if (started) throw new Error("Reviewer fixed dispatch can start exactly once");
      const identity = sha256Hex(JSON.stringify({
        baseRevision,
        target: target.targetHead,
        canonicalSkill: sha256Hex(d.canonicalSkill),
      }));
      let dispatch: AcceptedReviewerDispatch;
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
      } catch (error) {
        const p = preflight(error);
        if (!p) throw error;
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

export type { ReviewerPromptText };
export { isReviewerPromptText, sameReviewerPromptText };
