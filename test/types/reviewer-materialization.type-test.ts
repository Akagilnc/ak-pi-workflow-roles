/**
 * Pure typecheck fixture: materialization evidence shells are gone (ADR 0031 / #236).
 * Not registered as a runtime test — tsc include covers it.
 */
import type {
  ReviewerSuccessfulLegRunResult,
  ReviewerFailedLegRunResult,
} from "../../src/reviewer-agent.ts";
import type { ReviewerLegResultEvidence } from "../../src/reviewer-execution-ledger.ts";
import type { RuntimeReviewerOutcome } from "../../src/package-contracts/reviewer-output.ts";

export function assertPlainTextOutcomeContracts(
  runnerSuccess: ReviewerSuccessfulLegRunResult,
  ledgerSuccess: Extract<ReviewerLegResultEvidence, { status: "successful" }>,
  receiptSuccess: Extract<RuntimeReviewerOutcome, { status: "successful" }>,
  failure: ReviewerFailedLegRunResult,
): void {
  // Successful outcomes are plain text + workspace disposition — no materialization shell.
  const ok: readonly unknown[] = [runnerSuccess, ledgerSuccess, receiptSuccess, failure];
  void ok;
}
