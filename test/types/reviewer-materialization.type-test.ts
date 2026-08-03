/**
 * Pure typecheck fixture for materialization outcome contracts.
 * Not registered as a runtime test — tsc include covers it.
 */
import type {
  ReviewerSuccessfulLegRunResult,
  ReviewerFailedLegRunResult,
} from "../../src/reviewer-agent.ts";
import type { ReviewerLegResultEvidence } from "../../src/reviewer-execution-ledger.ts";
import type { RuntimeReviewerOutcome } from "../../src/package-contracts/reviewer-output.ts";

export function assertMaterializationOutcomeContracts(
  runnerSuccess: Omit<ReviewerSuccessfulLegRunResult, "runtimeConstructionEvidence">,
  ledgerSuccess: Omit<
    Extract<ReviewerLegResultEvidence, { status: "successful" }>,
    "runtimeConstructionEvidence"
  >,
  receiptSuccess: Omit<
    Extract<RuntimeReviewerOutcome, { status: "successful" }>,
    "runtimeConstructionEvidence"
  >,
  preMaterializationFailure: ReviewerFailedLegRunResult,
  postMaterializationFailure: ReviewerFailedLegRunResult &
    Required<Pick<ReviewerFailedLegRunResult, "runtimeConstructionEvidence">>,
): void {
  // @ts-expect-error successful runner outcomes require materialization evidence
  const invalidRunnerSuccess: ReviewerSuccessfulLegRunResult = runnerSuccess;
  // @ts-expect-error successful ledger outcomes require materialization evidence
  const invalidLedgerSuccess: ReviewerLegResultEvidence = ledgerSuccess;
  // @ts-expect-error successful receipt outcomes require materialization evidence
  const invalidReceiptSuccess: RuntimeReviewerOutcome = receiptSuccess;
  const validFailures: readonly ReviewerFailedLegRunResult[] = [
    preMaterializationFailure,
    postMaterializationFailure,
  ];
  void [invalidRunnerSuccess, invalidLedgerSuccess, invalidReceiptSuccess, validFailures];
}
