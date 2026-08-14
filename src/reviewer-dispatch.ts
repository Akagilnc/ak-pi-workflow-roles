import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import { immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
export { createReviewerPinnedGitReader, immutableReviewerPin, type ReviewerPinnedGitReader, type ReviewerPinnedTarget, type ReviewerRange } from "./reviewer-pinned-git.ts";
import { isReviewerPromptText, sameReviewerPromptText, type ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import { sha256Hex } from "./sha256.ts";
import {
  constructReviewerDispatch,
  discoverReviewerSpecAuthority,
  type ConstructedReviewerDispatch,
  type ReviewerSpecAuthorityDiscovery,
} from "./reviewer-construction.ts";
export {
  discoverReviewerSpecAuthority,
  type ReviewerSpecAuthorityDiscovery,
  type ReviewerSpecDisposition,
} from "./reviewer-construction.ts";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.ts";
export { sha256Hex } from "./sha256.ts";
export { isReviewerPromptText as isReviewerPromptIdentity, sameReviewerPromptText as sameReviewerPromptIdentity, type ReviewerPromptText as ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

const LOCAL_SPEC_ROOTS = ["docs", "specs", ".scratch"] as const;

async function listLocalSpecCandidatePaths(repositoryRoot: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (absoluteDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
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
export async function resolveReviewerSpecAuthorityDiscovery(input: {
  authorityRefs: readonly string[];
  reader: ReviewerPinnedGitReader;
  range: ReviewerRange;
}): Promise<ReviewerSpecAuthorityDiscovery> {
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
