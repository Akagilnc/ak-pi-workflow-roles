/** Package-owned worker (Coder/Fixer) output leaf — no role registration surface. */

export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";

export const CODER_ACCEPTED_TEXT = "Coder report accepted";
export const FIXER_ACCEPTED_TEXT = "Fixer report accepted";

export type WorkerRoleLabel = "Coder" | "Fixer";

export type WorkerOutput = {
  status: "planned" | "completed" | "refused";
  report: string;
  commitSha?: string;
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

/** Structural production validator for already-accepted worker tool details. */
export function validateAcceptedWorkerDetails(
  output: unknown,
  roleLabel: WorkerRoleLabel = "Coder",
): WorkerOutput {
  if (!isRecord(output)) {
    throw new Error(`${roleLabel} output must be an object`);
  }
  const expectedKeys = output.commitSha === undefined
    ? ["status", "report"]
    : ["status", "report", "commitSha"];
  if (
    !hasExactKeys(output, expectedKeys) ||
    (output.status !== "planned" && output.status !== "completed" &&
      output.status !== "refused") ||
    typeof output.report !== "string" || output.report.trim().length === 0 ||
    (output.commitSha !== undefined &&
      (typeof output.commitSha !== "string" ||
        output.commitSha.trim().length === 0))
  ) {
    throw new Error(
      `${roleLabel} output requires planned|completed|refused, a non-blank report, and an optional non-blank commitSha`,
    );
  }
  if (output.status === "planned" && output.commitSha !== undefined) {
    throw new Error(`${roleLabel} planned output forbids commitSha`);
  }
  return {
    status: output.status,
    report: output.report,
    ...(output.commitSha === undefined ? {} : { commitSha: output.commitSha }),
  };
}
