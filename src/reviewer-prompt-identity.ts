/**
 * ADR 0031: Reviewer model-visible text remains plain text.
 * No length/digest identity shell; callers compare strings directly when needed.
 */

export type ReviewerPromptText = string;

export function isReviewerPromptText(value: unknown): value is ReviewerPromptText {
  return typeof value === "string";
}

export function sameReviewerPromptText(
  first: ReviewerPromptText,
  second: ReviewerPromptText,
): boolean {
  return first === second;
}
