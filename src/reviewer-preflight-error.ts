export const REVIEWER_CORRECTABLE_PREFLIGHT_CODES = [
  "base-invalid",
  "range-invalid",
  "material-invalid",
] as const;

export type ReviewerCorrectablePreflightCode = (typeof REVIEWER_CORRECTABLE_PREFLIGHT_CODES)[number];

/** Closed policy error shared by concrete Git reads and dispatch compilation. */
export class ReviewerCorrectablePreflightError extends Error {
  constructor(readonly code: ReviewerCorrectablePreflightCode, readonly diagnostic = `${code} constraint failed`, options?: { cause?: unknown }) {
    super(`${code}: ${diagnostic}`, options);
    this.name = "ReviewerCorrectablePreflightError";
  }
}
