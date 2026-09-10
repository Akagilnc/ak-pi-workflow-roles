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
import { CorrectableSubmissionError } from "../submission-correctable-error.ts";
import { DOCTOR_ACCEPTED_TEXT, DOCTOR_OUTPUT_TOOL_NAME, validateDoctorSubmissionShape, validateRecordedDoctorOutput, type DoctorOutput, type DoctorSubmission } from "../doctor-contracts.ts";
import { GATEKEEPER_ACCEPTED_TEXT, GATEKEEPER_OUTPUT_TOOL_NAME, validateRecordedGatekeeperOutput, type GatekeeperDirectOutput } from "./gatekeeper-output.ts";
import { NAVIGATOR_ACCEPTED_TEXT, NAVIGATOR_OUTPUT_TOOL_NAME, validateRecordedNavigatorOutput, type NavigatorAdvice } from "./navigator-output.ts";
import { AUDITOR_ACCEPTED_TEXT, AUDITOR_OUTPUT_TOOL_NAME, validateRecordedAuditorOutput, type AuditorOutput } from "./auditor-output.ts";
import { MERGER_ACCEPTED_TEXT, MERGER_OUTPUT_TOOL_NAME, validateMergerOutput, type MergerOutput } from "../merger-contracts.ts";
import { NOTARY_ACCEPTED_TEXT, NOTARY_OUTPUT_TOOL_NAME, validateRecordedNotaryOutput, type NotaryOutput } from "../notary-contracts.ts";
import { COUNTERSIGN_ACCEPTED_TEXT, COUNTERSIGN_OUTPUT_TOOL_NAME, validateRecordedCountersignOutput, type CountersignVerdict } from "../countersign-contracts.ts";
import { GLEANER_LEFT_ACCEPTED_TEXT, GLEANER_LEFT_OUTPUT_TOOL_NAME, validateRecordedGleanerLeftOutput, type GleanerLeftOutput } from "../gleaner-left-contracts.ts";
import { INSPECTOR_ACCEPTED_TEXT, INSPECTOR_OUTPUT_TOOL_NAME, validateRecordedInspectorOutput, type InspectorOutput } from "../inspector-contracts.ts";
import { DIARIST_ACCEPTED_TEXT, DIARIST_OUTPUT_TOOL_NAME, validateRecordedDiaristOutput, type DiaristOutput } from "../diarist-contracts.ts";
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
  validateRecordedNotaryOutput,
  validateRecordedCountersignOutput,
  validateRecordedGleanerLeftOutput,
  validateRecordedInspectorOutput,
  validateRecordedGatekeeperOutput,
  validateRecordedNavigatorOutput,
  validateRecordedAuditorOutput,
  validateRecordedDiaristOutput,
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
  NotaryOutput,
  CountersignVerdict,
  GleanerLeftOutput,
  InspectorOutput,
  GatekeeperDirectOutput,
  NavigatorAdvice,
  AuditorOutput,
  DiaristOutput,
};

export const TERMINATING_TOOL_NAMES = [
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  COLLECTOR_OUTPUT_TOOL,
  DOCTOR_OUTPUT_TOOL_NAME,
  MERGER_OUTPUT_TOOL_NAME,
  NOTARY_OUTPUT_TOOL_NAME,
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  INSPECTOR_OUTPUT_TOOL_NAME,
  GATEKEEPER_OUTPUT_TOOL_NAME,
  NAVIGATOR_OUTPUT_TOOL_NAME,
  AUDITOR_OUTPUT_TOOL_NAME,
  DIARIST_OUTPUT_TOOL_NAME,
] as const;

export type TerminatingToolName = (typeof TERMINATING_TOOL_NAMES)[number];

export type AcceptedDetails =
  | WorkerOutput
  | RuntimeReviewerReceiptV2
  | JudgeVerdict
  | CollectorReceipt
  | DoctorOutput
  | MergerOutput
  | NotaryOutput
  | CountersignVerdict
  | GleanerLeftOutput
  | InspectorOutput
  | GatekeeperDirectOutput
  | NavigatorAdvice
  | AuditorOutput
  | DiaristOutput;

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
      return DOCTOR_ACCEPTED_TEXT;
    case MERGER_OUTPUT_TOOL_NAME:
      return MERGER_ACCEPTED_TEXT;
    case NOTARY_OUTPUT_TOOL_NAME:
      return NOTARY_ACCEPTED_TEXT;
    case COUNTERSIGN_OUTPUT_TOOL_NAME:
      return COUNTERSIGN_ACCEPTED_TEXT;
    case GLEANER_LEFT_OUTPUT_TOOL_NAME:
      return GLEANER_LEFT_ACCEPTED_TEXT;
    case INSPECTOR_OUTPUT_TOOL_NAME:
      return INSPECTOR_ACCEPTED_TEXT;
    case GATEKEEPER_OUTPUT_TOOL_NAME:
      return GATEKEEPER_ACCEPTED_TEXT;
    case NAVIGATOR_OUTPUT_TOOL_NAME:
      return NAVIGATOR_ACCEPTED_TEXT;
    case AUDITOR_OUTPUT_TOOL_NAME:
      return AUDITOR_ACCEPTED_TEXT;
    case DIARIST_OUTPUT_TOOL_NAME:
      return DIARIST_ACCEPTED_TEXT;
  }
}

export class AcceptedDetailsContractError extends CorrectableSubmissionError {
  readonly code = "accepted_details_contract" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcceptedDetailsContractError";
  }
}


/**
 * #836: status allowlist rejection deleted. Original object is the receipt.
 * Callers that need a typed view may still cast; code must not bounce on status.
 */
export function validateAcceptedDetails(
  _toolName: TerminatingToolName,
  details: unknown,
): AcceptedDetails {
  if (details !== null && typeof details === "object" && !Array.isArray(details)) {
    return details as AcceptedDetails;
  }
  // Non-object payload still records as empty object rather than rejecting.
  return {} as AcceptedDetails;
}

/**
 * #836: args↔details equality rejection deleted. Details are recorded as submitted.
 */
export function validateAcceptedLifecycle(
  toolName: TerminatingToolName,
  _argumentsValue: unknown,
  detailsValue: unknown,
): AcceptedDetails {
  return validateAcceptedDetails(toolName, detailsValue);
}

/** Machine-facing facts from an accepted terminating receipt. No presentation joins. */
export type AcceptedFacts = {
  status?: string;
  commit?: string;
};

/** Read status/commit leaves the role wrote — never invent defaults (#836). */
export function acceptedFacts(toolName: TerminatingToolName, details: AcceptedDetails): AcceptedFacts {
  const record = details as Record<string, unknown>;
  switch (toolName) {
    case JUDGE_OUTPUT_TOOL_NAME:
      return typeof record.judgeStatus === "string" ? { status: record.judgeStatus } : {};
    case COUNTERSIGN_OUTPUT_TOOL_NAME:
      return typeof record.countersignStatus === "string" ? { status: record.countersignStatus } : {};
    case MERGER_OUTPUT_TOOL_NAME: {
      const status = typeof record.status === "string" ? record.status : undefined;
      return {
        ...(status === undefined ? {} : { status }),
        ...(status === "completed" && typeof record.mergeCommitId === "string"
          ? { commit: record.mergeCommitId }
          : {}),
      };
    }
    case COLLECTOR_OUTPUT_TOOL:
      // Collector has no status leaf — do not invent "collected".
      return typeof record.status === "string" ? { status: record.status } : {};
    default:
      return typeof record.status === "string" ? { status: record.status } : {};
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
