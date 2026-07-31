/** Package-owned Reviewer output leaf — no role registration surface. */

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "Reviewer report accepted";

export type ReviewerOutput =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "refused"; diagnostic: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function validateAcceptedReviewerDetails(output: unknown): ReviewerOutput {
  if (!isRecord(output)) throw new Error("Reviewer output must be a completed or refused intent");
  if (output.status === "completed" && exactKeys(output, ["status"])) return { status: "completed" };
  if (output.status === "refused" && exactKeys(output, ["status", "diagnostic"]) &&
      typeof output.diagnostic === "string" && output.diagnostic.trim().length > 0) {
    return { status: "refused", diagnostic: output.diagnostic };
  }
  throw new Error("Reviewer completed intent has no report; refused requires only a separate non-blank diagnostic");
}
