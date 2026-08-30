/** Shared, unforgeable identity for submission errors that the same session may correct. */
const correctableSubmissionErrorBrand = Symbol("ak-roles.correctable-submission-error");

export abstract class CorrectableSubmissionError extends Error {
  readonly [correctableSubmissionErrorBrand] = true;
}

export function isCorrectableSubmissionError(error: unknown): error is CorrectableSubmissionError {
  return error instanceof CorrectableSubmissionError;
}
