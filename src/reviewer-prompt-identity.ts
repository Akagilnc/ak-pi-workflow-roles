import { sha256Hex } from "./sha256.ts";

/** Dispatch-owned exact identity for model-visible prompt bytes. */
export type ReviewerPromptIdentity = Readonly<{
  bytes: string;
  utf8Length: number;
  sha256: string;
}>;

export function reviewerPromptIdentity(bytes: string): ReviewerPromptIdentity {
  return Object.freeze({
    bytes,
    utf8Length: Buffer.byteLength(bytes, "utf8"),
    sha256: sha256Hex(bytes),
  });
}

export function isReviewerPromptIdentity(value: ReviewerPromptIdentity): boolean {
  const actual = reviewerPromptIdentity(value.bytes);
  return value.utf8Length === actual.utf8Length && value.sha256 === actual.sha256;
}
