/** Shared, unforgeable identity for submission errors that the same session may correct. */
const correctableSubmissionErrorBrand = Symbol("ak-roles.correctable-submission-error");
export class CorrectableSubmissionError extends Error {
    [correctableSubmissionErrorBrand] = true;
}
export function isCorrectableSubmissionError(error) {
    return error instanceof CorrectableSubmissionError;
}
