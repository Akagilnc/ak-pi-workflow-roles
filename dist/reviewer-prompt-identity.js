/**
 * ADR 0031: Reviewer model-visible text remains plain text.
 * No length/digest identity shell; callers compare strings directly when needed.
 */
export function isReviewerPromptText(value) {
    return typeof value === "string";
}
export function sameReviewerPromptText(first, second) {
    return first === second;
}
