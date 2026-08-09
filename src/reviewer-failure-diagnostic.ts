import type { ReviewerFailureClassification } from "./reviewer-execution-ledger.ts";

export function normalizeReviewerFailureDiagnostic(error: unknown, failure: ReviewerFailureClassification): string {
  const original = error instanceof Error && Object.hasOwn(error, "cause") && !(error.cause instanceof Error)
    ? error.cause
    : error;
  const message = original instanceof Error
    ? original.message.trim()
    : typeof original === "string"
      ? original.trim()
      : typeof original === "object" && original !== null && typeof (original as { errorMessage?: unknown }).errorMessage === "string"
        ? (original as { errorMessage: string }).errorMessage.trim()
        : "";
  if (message !== "") return message;
  return failure === "provider"
    ? "Reviewer Agent provider supplied no diagnostic details"
    : "Reviewer Agent failed without diagnostic details";
}
