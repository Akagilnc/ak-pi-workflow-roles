/** Package-owned Reviewer intent — original role payload only (#836 删 8). */

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "御史台回执已接受";

/** Seat-owned per-lens finding body text (completeness / correctness). */
export type ReviewerAmendments = Readonly<
  Partial<Record<"completeness" | "correctness", string>>
>;
export type ReviewerIntent =
  | Readonly<{ status: "completed"; amendments?: ReviewerAmendments }>
  | Readonly<{ status: "refused"; diagnostic: string; amendments?: ReviewerAmendments }>;

export function validateReviewerIntent(output: unknown): ReviewerIntent {
  return output as ReviewerIntent;
}
