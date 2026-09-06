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
import { CorrectableSubmissionError } from "../submission-correctable-error.ts";
import { DOCTOR_ACCEPTED_TEXT, DOCTOR_OUTPUT_TOOL_NAME, validateDoctorSubmissionShape, validateRecordedDoctorOutput, type DoctorOutput, type DoctorSubmission } from "../doctor-contracts.ts";
import { GATEKEEPER_ACCEPTED_TEXT, GATEKEEPER_OUTPUT_TOOL_NAME, validateRecordedGatekeeperOutput, type GatekeeperDirectOutput } from "./gatekeeper-output.ts";
import { NAVIGATOR_ACCEPTED_TEXT, NAVIGATOR_OUTPUT_TOOL_NAME, validateRecordedNavigatorOutput, type NavigatorAdvice } from "./navigator-output.ts";
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

function safeProperty(candidate: Record<string, unknown> | undefined, property: string): unknown {
  try {
    return candidate?.[property];
  } catch {
    return undefined;
  }
}

export function validateAcceptedDetails(
  toolName: TerminatingToolName,
  details: unknown,
): AcceptedDetails {
  const candidate = details !== null && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
  let auditEscalation = false;
  try {
    auditEscalation = isAuditEscalationResult(details);
  } catch {
    // Hostile getters are not recognizable audit escalation evidence.
  }
  if (auditEscalation || safeProperty(candidate, "kind") === "audit_escalation") {
    throw new AcceptedDetailsContractError(
      "audit escalation is not an accepted role receipt",
    );
  }
  const statusKey =
    toolName === JUDGE_OUTPUT_TOOL_NAME
      ? "judgeStatus"
      : toolName === COUNTERSIGN_OUTPUT_TOOL_NAME
        ? "countersignStatus"
        : "status";
  const discriminator = safeProperty(candidate, statusKey);
  const lawfulStatuses: Readonly<Record<TerminatingToolName, readonly string[]>> = {
    [CODER_OUTPUT_TOOL_NAME]: ["planned", "completed", "refused", "unfinished"],
    [FIXER_OUTPUT_TOOL_NAME]: ["planned", "completed", "refused", "partially_completed", "unfinished"],
    [REVIEWER_OUTPUT_TOOL_NAME]: ["completed", "refused"],
    [JUDGE_OUTPUT_TOOL_NAME]: ["converged", "continue", "escalate"],
    [COLLECTOR_OUTPUT_TOOL]: [],
    [DOCTOR_OUTPUT_TOOL_NAME]: ["completed", "refused"],
    [MERGER_OUTPUT_TOOL_NAME]: ["completed", "escalate"],
    [NOTARY_OUTPUT_TOOL_NAME]: ["pass", "bounce"],
    [COUNTERSIGN_OUTPUT_TOOL_NAME]: ["converged", "continue", "escalate"],
    [GLEANER_LEFT_OUTPUT_TOOL_NAME]: ["completed"],
    [INSPECTOR_OUTPUT_TOOL_NAME]: ["pass", "bounce"],
    [GATEKEEPER_OUTPUT_TOOL_NAME]: ["dispatch", "pass"],
    [NAVIGATOR_OUTPUT_TOOL_NAME]: ["advice"],
    [DIARIST_OUTPUT_TOOL_NAME]: ["completed"],
  };
  const collectorDiscriminator = toolName === COLLECTOR_OUTPUT_TOOL && Array.isArray(candidate?.groups);
  const baseDiscriminator = discriminator;
  const runtimeBindingMissing =
    (toolName === DOCTOR_OUTPUT_TOOL_NAME && baseDiscriminator === "completed" && !(candidate?.cost !== null && typeof candidate?.cost === "object")) ||
    (toolName === REVIEWER_OUTPUT_TOOL_NAME && candidate?.version !== 2);
  if (
    runtimeBindingMissing ||
    (!collectorDiscriminator && (typeof discriminator !== "string" || !lawfulStatuses[toolName].includes(baseDiscriminator as string)))
  ) {
    throw new AcceptedDetailsContractError("terminating receipt has no recognized execution discriminator");
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
    case NOTARY_OUTPUT_TOOL_NAME:
      return validateRecordedNotaryOutput(details);
    case COUNTERSIGN_OUTPUT_TOOL_NAME:
      return validateRecordedCountersignOutput(details);
    case GLEANER_LEFT_OUTPUT_TOOL_NAME:
      return validateRecordedGleanerLeftOutput(details);
    case INSPECTOR_OUTPUT_TOOL_NAME:
      return validateRecordedInspectorOutput(details);
    case GATEKEEPER_OUTPUT_TOOL_NAME:
      return validateRecordedGatekeeperOutput(details);
    case NAVIGATOR_OUTPUT_TOOL_NAME:
      return validateRecordedNavigatorOutput(details);
    case DIARIST_OUTPUT_TOOL_NAME:
      return validateRecordedDiaristOutput(details);
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
    if ((String(testimony.status)) === "refused") {
      if (!deepEqual(testimony, details)) throw new Error("accepted tool lifecycle details mismatch");
      return details;
    }
    const receipt = details as DoctorOutput & { cost?: unknown };
    if ((String(receipt.status)) !== "completed") {
      throw new Error("accepted tool lifecycle details mismatch");
    }
    const { cost: _runtimeCost, ...projected } = receipt;
    if (!deepEqual(testimony, projected)) throw new Error("accepted tool lifecycle details mismatch");
    return details;
  }
  if (toolName === DIARIST_OUTPUT_TOOL_NAME) {
    // Envelope-owned mechanical sitian facts are runtime-bound on details only
    // (same shape as the Doctor runtime cost); the submitted arguments carry the
    // role's own selections. Machine facts never come from model self-report.
    const { sitian: _mechanical, ...submitted } = details as DiaristOutput & { sitian?: unknown };
    const testimony = validateAcceptedDetails(toolName, argumentsValue);
    if (!deepEqual(testimony, submitted)) throw new Error("accepted tool lifecycle details mismatch");
    return details;
  }
  const argumentsDetails = validateAcceptedDetails(toolName, argumentsValue);
  if (!deepEqual(argumentsDetails, details)) throw new Error("accepted tool lifecycle details mismatch");
  return details;
}

/** Machine-facing facts from an accepted terminating receipt. No presentation joins. */
export type AcceptedFacts = {
  status?: string;
  commit?: string;
};

export function acceptedFacts(toolName: TerminatingToolName, details: AcceptedDetails): AcceptedFacts {
  switch (toolName) {
    case CODER_OUTPUT_TOOL_NAME:
    case FIXER_OUTPUT_TOOL_NAME:
    case REVIEWER_OUTPUT_TOOL_NAME:
    case DOCTOR_OUTPUT_TOOL_NAME:
    case NOTARY_OUTPUT_TOOL_NAME:
    case GLEANER_LEFT_OUTPUT_TOOL_NAME:
    case INSPECTOR_OUTPUT_TOOL_NAME:
    case GATEKEEPER_OUTPUT_TOOL_NAME:
    case NAVIGATOR_OUTPUT_TOOL_NAME:
    case DIARIST_OUTPUT_TOOL_NAME: return { status: (details as { status: string }).status };
    case JUDGE_OUTPUT_TOOL_NAME: return { status: (details as { judgeStatus: string }).judgeStatus };
    case COUNTERSIGN_OUTPUT_TOOL_NAME: return { status: (details as { countersignStatus: string }).countersignStatus };
    case MERGER_OUTPUT_TOOL_NAME: {
      const output = details as unknown as Record<string, unknown>;
      const status = output.status as string;
      return { status, ...(status === "completed" && typeof output.mergeCommitId === "string" ? { commit: output.mergeCommitId } : {}) };
    }
    case COLLECTOR_OUTPUT_TOOL:
      return { status: "collected" };
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
