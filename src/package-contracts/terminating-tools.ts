/**
 * Package-owned terminating tool registry.
 * Recorder and roles share these leaves; Recorder must not load role registration.
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
  validateAcceptedReviewerDetails,
  validateRuntimeReviewerReceipt,
  type ReviewerOutput,
  type RuntimeReviewerReceiptV2,
} from "./reviewer-output.ts";
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
  validateAcceptedCollectorReceipt,
  validateAcceptedJudgeDetails,
  projectReviewerIntentToReceipt,
  validateAcceptedReviewerDetails,
  validateRuntimeReviewerReceipt,
  validateAcceptedWorkerDetails,
};
export type {
  CollectorReceipt,
  JudgeVerdict,
  ReviewerOutput,
  RuntimeReviewerReceiptV2,
  WorkerOutput,
};

export const TERMINATING_TOOL_NAMES = [
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  COLLECTOR_OUTPUT_TOOL,
] as const;

export type TerminatingToolName = (typeof TERMINATING_TOOL_NAMES)[number];

export type AcceptedDetails =
  | WorkerOutput
  | RuntimeReviewerReceiptV2
  | JudgeVerdict
  | CollectorReceipt;

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
  }
}

export function validateAcceptedDetails(
  toolName: TerminatingToolName,
  details: unknown,
): AcceptedDetails {
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
  }
}

export function carriesPackageAuditObservation(
  toolName: TerminatingToolName,
): boolean {
  return (
    toolName === JUDGE_OUTPUT_TOOL_NAME ||
    toolName === REVIEWER_OUTPUT_TOOL_NAME
  );
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
