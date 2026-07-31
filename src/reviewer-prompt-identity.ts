import { sha256Hex } from "./sha256.ts";

/** Dispatch-owned exact identity for model-visible prompt bytes. */
export type ReviewerPromptIdentity = Readonly<{
  text: string;
  utf8Length: number;
  sha256: string;
}>;

export function reviewerPromptIdentity(text: string): ReviewerPromptIdentity {
  return Object.freeze({
    text,
    utf8Length: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text),
  });
}

export function isReviewerPromptIdentity(value: ReviewerPromptIdentity): boolean {
  const actual = reviewerPromptIdentity(value.text);
  return value.utf8Length === actual.utf8Length && value.sha256 === actual.sha256;
}

export function sameReviewerPromptIdentity(
  first: ReviewerPromptIdentity,
  second: ReviewerPromptIdentity,
): boolean {
  return first.text === second.text &&
    first.utf8Length === second.utf8Length &&
    first.sha256 === second.sha256;
}
