/**
 * Public Auditor (审刑院) terminating receipt contracts (#675 / #754).
 * Lawful explicit releases: converged | continue | escalate.
 */
import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, reviewSubmissionSchema } from "../review-submission.ts";

export const AUDITOR_OUTPUT_TOOL_NAME: string = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;

export const auditorOutputSchema = reviewSubmissionSchema;

export type AuditorOutput =
  | { readonly status: "converged" }
  | { readonly status: "continue"; readonly violations?: unknown }
  | {
      readonly status: "escalate";
      readonly conflicts?: unknown;
      readonly decisionGate?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** #836: no field drop — original object is the receipt. */
export function projectLawfulAuditorOutput(value: unknown): AuditorOutput | undefined {
  return isRecord(value) ? (value as AuditorOutput) : undefined;
}

export function validateRecordedAuditorOutput(value: unknown): AuditorOutput {
  if (!isRecord(value)) throw new Error("Auditor output is not an object");
  return value as AuditorOutput;
}
