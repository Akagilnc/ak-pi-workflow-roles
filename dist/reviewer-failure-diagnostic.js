export function normalizeReviewerFailureDiagnostic(error, failure) {
    const message = error instanceof Error ? error.message.trim() : String(error).trim();
    if (message !== "")
        return message;
    return failure === "provider"
        ? "Reviewer Agent provider supplied no diagnostic details"
        : "Reviewer Agent failed without diagnostic details";
}
