/**
 * Package-owned terminating tool registry.
 * Package roles share these terminating leaves.
 */

import {
  COLLECTOR_OUTPUT_TOOL,
  validateAcceptedCollectorReceipt,
  type CollectorReceipt,
} from "./collector-output.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./judge-output.ts";
import {
  REVIEWER_OUTPUT_TOOL_NAME,
  validateReviewerIntent,
  type ReviewerIntent,
} from "./reviewer-output.ts";
import { PACKAGED_ROLE_REGISTRY } from "../packaged-role-registry.ts";
import { CorrectableSubmissionError } from "../submission-correctable-error.ts";
import { DOCTOR_OUTPUT_TOOL_NAME, validateDoctorSubmissionShape, validateRecordedDoctorOutput, type DoctorOutput, type DoctorSubmission } from "../doctor-contracts.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME, validateRecordedGatekeeperOutput, type GatekeeperDirectOutput } from "./gatekeeper-output.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME, validateRecordedNavigatorOutput, type NavigatorAdvice } from "./navigator-output.ts";
import { AUDITOR_OUTPUT_TOOL_NAME, validateRecordedAuditorOutput, type AuditorOutput } from "./auditor-output.ts";
import { MERGER_OUTPUT_TOOL_NAME, validateMergerOutput, type MergerOutput } from "../merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME, validateRecordedNotaryOutput, type NotaryOutput } from "../notary-contracts.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME, validateRecordedCountersignOutput, type CountersignVerdict } from "../countersign-contracts.ts";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME, validateRecordedGleanerLeftOutput, type GleanerLeftOutput } from "../gleaner-left-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME, validateRecordedInspectorOutput, type InspectorOutput } from "../inspector-contracts.ts";
import { DIARIST_OUTPUT_TOOL_NAME, validateRecordedDiaristOutput, type DiaristOutput } from "../diarist-contracts.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME, type SecretariatVerdict } from "../secretariat-contracts.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  validateAcceptedWorkerDetails,
  type WorkerOutput,
} from "./worker-output.ts";

export {
  CODER_OUTPUT_TOOL_NAME,
  COLLECTOR_OUTPUT_TOOL,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  MERGER_OUTPUT_TOOL_NAME,
  validateAcceptedCollectorReceipt,
  validateAcceptedJudgeDetails,
  validateReviewerIntent,
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
  SecretariatVerdict,
};

export const TERMINATING_TOOL_NAMES = PACKAGED_ROLE_REGISTRY.map((entry) => entry.outputTool);

export type TerminatingToolName = (typeof TERMINATING_TOOL_NAMES)[number];

export type AcceptedDetails =
  | WorkerOutput
  | ReviewerIntent
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
  | DiaristOutput
  | SecretariatVerdict;

export function isTerminatingToolName(
  name: string,
): name is TerminatingToolName {
  return (TERMINATING_TOOL_NAMES as readonly string[]).includes(name);
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
  const entry = PACKAGED_ROLE_REGISTRY.find((candidate) => candidate.outputTool === toolName);
  const statusKey = entry !== undefined && "receiptStatusKey" in entry ? entry.receiptStatusKey : "status";
  const status = typeof record[statusKey] === "string" ? record[statusKey] : undefined;
  const commitKey = entry !== undefined && "receiptCommitKey" in entry ? entry.receiptCommitKey : undefined;
  const commitWhen = entry !== undefined && "receiptCommitWhen" in entry ? entry.receiptCommitWhen : undefined;
  const commit = commitKey !== undefined
    && status === commitWhen
    && typeof record[commitKey] === "string"
    ? record[commitKey]
    : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(commit === undefined ? {} : { commit }),
  };
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
