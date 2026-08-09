export function normalizeReviewerFailureDiagnostic(error, failure) {
    const original = error instanceof Error && "reviewerFailure" in error && Object.hasOwn(error, "cause") && !(error.cause instanceof Error)
        ? error.cause
        : error;
    const message = original instanceof Error
        ? original.message.trim()
        : typeof original === "string"
            ? original.trim()
            : typeof original === "object" && original !== null && typeof original.errorMessage === "string"
                ? original.errorMessage.trim()
                : "";
    if (message !== "")
        return message;
    return failure === "provider"
        ? "Reviewer Agent provider supplied no diagnostic details"
        : "Reviewer Agent failed without diagnostic details";
}
