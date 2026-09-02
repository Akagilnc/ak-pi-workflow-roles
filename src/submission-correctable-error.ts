import {
  GatekeeperDecisionError,
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
} from "./submission-errors.ts";

/** Shared, unforgeable identity for submission errors that the same session may correct. */
const correctableSubmissionErrorBrand = Symbol("ak-roles.correctable-submission-error");

export abstract class CorrectableSubmissionError extends Error {
  readonly [correctableSubmissionErrorBrand] = true;
}

export function isCorrectableSubmissionError(error: unknown): error is CorrectableSubmissionError {
  return error instanceof CorrectableSubmissionError;
}

/**
 * Execute-path throws the same session may correct: branded correctable errors plus
 * gatekeeper bounce/no_receipt and worker reminder classes (ledger + Grok MCP catch).
 * One predicate — do not re-list instanceof chains at each catch.
 */
export function isCorrectableExecuteError(error: unknown): boolean {
  return (
    isCorrectableSubmissionError(error)
    || error instanceof GatekeeperDecisionError
    || error instanceof WorkerCommitReminderError
    || error instanceof WorkerPrefixReminderError
    || error instanceof WorkerUnfinishedReasonReminderError
  );
}
