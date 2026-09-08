import {
  GatekeeperDecisionError,
  ParentQueueReaskError,
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
    || error instanceof ParentQueueReaskError
    || error instanceof WorkerCommitReminderError
    || error instanceof WorkerPrefixReminderError
    || error instanceof WorkerUnfinishedReasonReminderError
  );
}

/**
 * Durable projection for ACP envelope tool catches only.
 * Pi path keeps native throw → isError toolResult (no shared projection consumer).
 */
export type CorrectableExecuteRejectionProjection = {
  readonly diagnostic: string;
  readonly details: Record<string, unknown>;
};

/**
 * One authority for correctable execute → diagnostic text + structured details.
 * Consumed by the ACP envelope tool catch; host adapters wrap transport shape only.
 */
export function projectCorrectableExecuteRejection(
  error: unknown,
): CorrectableExecuteRejectionProjection {
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (error instanceof GatekeeperDecisionError) {
    return { diagnostic, details: { ...(error.result as Record<string, unknown>) } };
  }
  if (
    error instanceof WorkerCommitReminderError
    || error instanceof WorkerPrefixReminderError
    || error instanceof WorkerUnfinishedReasonReminderError
  ) {
    return { diagnostic, details: { code: error.code } };
  }
  if (typeof (error as { code?: unknown }).code === "string") {
    return { diagnostic, details: { code: (error as { code: string }).code } };
  }
  return {
    diagnostic,
    details: {
      code: error instanceof Error && error.name ? error.name : "correctable-submission-error",
    },
  };
}
