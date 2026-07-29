/** Package-owned Reviewer output leaf — no role registration surface. */

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "Reviewer report accepted";

export type ReviewerOutput = {
  status: "completed" | "refused";
  report: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

export function validateAcceptedReviewerDetails(
  output: unknown,
): ReviewerOutput {
  if (
    !isRecord(output) || !hasExactKeys(output, ["status", "report"]) ||
    (output.status !== "completed" && output.status !== "refused") ||
    typeof output.report !== "string" || output.report.trim().length === 0
  ) {
    throw new Error(
      "Reviewer output requires only completed|refused and a non-blank Markdown report",
    );
  }
  return { status: output.status, report: output.report };
}
