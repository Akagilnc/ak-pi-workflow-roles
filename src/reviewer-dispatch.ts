/**
 * #836 删 8: no code-compiled axis dispatch.
 * Parent seat invokes packaged ak-cross-m-review skill; this module does not construct or run children.
 */
export {
  branchNamesAtPinnedHead,
  createReviewerPinnedGitReader,
  immutableReviewerPin,
  type ReviewerPinnedGitReader,
  type ReviewerPinnedTarget,
  type ReviewerRange,
} from "./reviewer-pinned-git.ts";
export { extractReferencedAdrPaths } from "./adr-path-refs.ts";
export { sha256Hex } from "./sha256.ts";
export {
  isReviewerPromptText as isReviewerPromptIdentity,
  sameReviewerPromptText as sameReviewerPromptIdentity,
  type ReviewerPromptText as ReviewerPromptIdentity,
} from "./reviewer-prompt-identity.ts";

export type ReviewerIssueFetchResult = Readonly<{
  number: number;
  title?: string;
  body?: string;
}>;

export type ReviewerIssueFetcher = (input: {
  repo: string;
  ticketNumber: number;
  signal?: AbortSignal;
}) => Promise<ReviewerIssueFetchResult | undefined>;
