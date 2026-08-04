/**
 * Package-owned terminating tool registry.
 * Package roles share these terminating leaves.
 */

import {
  COLLECTOR_ACCEPTED_TEXT,
  COLLECTOR_OUTPUT_TOOL,
  validateAcceptedCollectorReceipt,
  type CollectorReceipt,
} from "./collector-output.ts";
import {
  JUDGE_ACCEPTED_TEXT,
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./judge-output.ts";
import {
  REVIEWER_ACCEPTED_TEXT,
  REVIEWER_OUTPUT_TOOL_NAME,
  projectReviewerIntentToReceipt,
  validateReviewerIntent,
  validateRuntimeReviewerReceipt,
  type ReviewerIntent,
  type RuntimeReviewerReceiptV2,
} from "./reviewer-output.ts";
import { isAuditEscalationResult } from "../audit-escalation.ts";
import { DOCTOR_OUTPUT_TOOL_NAME, validateDoctorSubmissionShape, validateRecordedDoctorOutput, type DoctorOutput, type DoctorSubmission } from "../doctor-contracts.ts";
import { MERGER_ACCEPTED_TEXT, MERGER_OUTPUT_TOOL_NAME, validateMergerOutput, type MergerOutput } from "../merger-contracts.ts";
import {
  CODER_ACCEPTED_TEXT,
  CODER_OUTPUT_TOOL_NAME,
  FIXER_ACCEPTED_TEXT,
  FIXER_OUTPUT_TOOL_NAME,
  validateAcceptedWorkerDetails,
  type WorkerOutput,
} from "./worker-output.ts";

export {
  CODER_ACCEPTED_TEXT,
  CODER_OUTPUT_TOOL_NAME,
  COLLECTOR_ACCEPTED_TEXT,
  COLLECTOR_OUTPUT_TOOL,
  FIXER_ACCEPTED_TEXT,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_ACCEPTED_TEXT,
  JUDGE_OUTPUT_TOOL_NAME,
  REVIEWER_ACCEPTED_TEXT,
  REVIEWER_OUTPUT_TOOL_NAME,
  MERGER_ACCEPTED_TEXT,
  MERGER_OUTPUT_TOOL_NAME,
  validateAcceptedCollectorReceipt,
  validateAcceptedJudgeDetails,
  projectReviewerIntentToReceipt,
  validateReviewerIntent,
  validateRuntimeReviewerReceipt,
  validateAcceptedWorkerDetails,
  validateDoctorSubmissionShape,
  validateRecordedDoctorOutput,
  validateMergerOutput,
};
export type {
  CollectorReceipt,
  JudgeVerdict,
  ReviewerIntent,
  RuntimeReviewerReceiptV2,
  WorkerOutput,
  DoctorOutput,
  DoctorSubmission,
  MergerOutput,
};

export const TERMINATING_TOOL_NAMES = [
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  COLLECTOR_OUTPUT_TOOL,
  DOCTOR_OUTPUT_TOOL_NAME,
  MERGER_OUTPUT_TOOL_NAME,
] as const;

export type TerminatingToolName = (typeof TERMINATING_TOOL_NAMES)[number];

export type AcceptedDetails =
  | WorkerOutput
  | RuntimeReviewerReceiptV2
  | JudgeVerdict
  | CollectorReceipt
  | DoctorOutput
  | MergerOutput;

export function isTerminatingToolName(
  name: string,
): name is TerminatingToolName {
  return (TERMINATING_TOOL_NAMES as readonly string[]).includes(name);
}

export function acceptedTextFor(toolName: TerminatingToolName): string {
  switch (toolName) {
    case CODER_OUTPUT_TOOL_NAME:
      return CODER_ACCEPTED_TEXT;
    case FIXER_OUTPUT_TOOL_NAME:
      return FIXER_ACCEPTED_TEXT;
    case REVIEWER_OUTPUT_TOOL_NAME:
      return REVIEWER_ACCEPTED_TEXT;
    case JUDGE_OUTPUT_TOOL_NAME:
      return JUDGE_ACCEPTED_TEXT;
    case COLLECTOR_OUTPUT_TOOL:
      return COLLECTOR_ACCEPTED_TEXT;
    case DOCTOR_OUTPUT_TOOL_NAME:
      return "Doctor output accepted";
    case MERGER_OUTPUT_TOOL_NAME:
      return MERGER_ACCEPTED_TEXT;
  }
}

export class AcceptedDetailsContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcceptedDetailsContractError";
  }
}

export function validateAcceptedDetails(
  toolName: TerminatingToolName,
  details: unknown,
): AcceptedDetails {
  if (isAuditEscalationResult(details)) {
    throw new AcceptedDetailsContractError(
      "audit escalation is not an accepted role receipt",
    );
  }
  try {
    switch (toolName) {
    case CODER_OUTPUT_TOOL_NAME:
      return validateAcceptedWorkerDetails(details, "Coder");
    case FIXER_OUTPUT_TOOL_NAME:
      return validateAcceptedWorkerDetails(details, "Fixer");
    case REVIEWER_OUTPUT_TOOL_NAME:
      return validateRuntimeReviewerReceipt(details);
    case JUDGE_OUTPUT_TOOL_NAME:
      return validateAcceptedJudgeDetails(details);
    case COLLECTOR_OUTPUT_TOOL:
      return validateAcceptedCollectorReceipt(details);
    case DOCTOR_OUTPUT_TOOL_NAME:
      return validateRecordedDoctorOutput(details);
    case MERGER_OUTPUT_TOOL_NAME:
      return validateMergerOutput(details);
    }
  } catch (error) {
    if (error instanceof Error && error.constructor === Error) throw new AcceptedDetailsContractError(error.message, { cause: error });
    throw error;
  }
}

export function validateAcceptedLifecycle(
  toolName: TerminatingToolName,
  argumentsValue: unknown,
  detailsValue: unknown,
): AcceptedDetails {
  const details = validateAcceptedDetails(toolName, detailsValue);
  if (toolName === DOCTOR_OUTPUT_TOOL_NAME) {
    const testimony = validateDoctorSubmissionShape(argumentsValue);
    if (testimony.status === "refused") {
      if (!deepEqual(testimony, details)) throw new Error("accepted tool lifecycle details mismatch");
      return details;
    }
    const receipt = details as DoctorOutput;
    if (receipt.status !== "completed") throw new Error("accepted tool lifecycle details mismatch");
    const { cost: _runtimeCost, ...projected } = receipt;
    if (!deepEqual(testimony, projected)) throw new Error("accepted tool lifecycle details mismatch");
    return details;
  }
  const argumentsDetails = validateAcceptedDetails(toolName, argumentsValue);
  if (!deepEqual(argumentsDetails, details)) throw new Error("accepted tool lifecycle details mismatch");
  return details;
}

export function acceptedFacts(toolName: TerminatingToolName, details: AcceptedDetails): { status?: string; commit?: string } {
  switch (toolName) {
    case CODER_OUTPUT_TOOL_NAME: return { status: (details as WorkerOutput).status };
    case FIXER_OUTPUT_TOOL_NAME: return { status: (details as WorkerOutput).status };
    case REVIEWER_OUTPUT_TOOL_NAME: return { status: (details as RuntimeReviewerReceiptV2).status };
    case JUDGE_OUTPUT_TOOL_NAME: return { status: (details as JudgeVerdict).judgeStatus };
    case DOCTOR_OUTPUT_TOOL_NAME: return { status: (details as DoctorOutput).status };
    case MERGER_OUTPUT_TOOL_NAME: { const output = details as MergerOutput; return { status: output.status, ...(output.status === "completed" ? { commit: output.mergeCommitId } : {}) }; }
    case COLLECTOR_OUTPUT_TOOL: return {};
  }
}

/** Deep structural equality for lifecycle agreement checks. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || b === null || Array.isArray(b)) return false;
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((key, index) => key === bKeys[index])) return false;
    return aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    );
  }
  return false;
}
