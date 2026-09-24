/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: converged | continue | escalate.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, reviewSubmissionSchema } from "./review-submission.ts";

export const NOTARY_OUTPUT_TOOL_NAME: string = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;
export const NOTARY_SOURCE_RUN_FLAG = {
  name: "ak-notary-source-run",
  definition: {
    description: "Absolute source run directory bound for Notary self-fetch",
    type: "string" as const,
  },
} as const;

/** Optional ticket binding for court-diary (起居录) lookup — ADR 0075. */
export const NOTARY_TICKET_FLAG = {
  name: "ak-notary-ticket-number",
  definition: {
    description: "Optional ticket number for Notary court-diary lookup",
    type: "string" as const,
  },
} as const;

export const notaryOutputSchema = reviewSubmissionSchema;

export type NotarySourceRunLocator = {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: string;
};

/** Recognition face only — fields retained as submitted (#753, no disposition/findings forge). */
export type NotaryOutput =
  | { readonly status: "converged"; readonly findings?: unknown }
  | { readonly status: "continue"; readonly findings?: unknown }
  | {
      readonly status: "escalate";
      readonly reason?: unknown;
      readonly findings?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recognize one lawful explicit Notary release (converged | continue | escalate).
 * #753: no field rewrite — submitted params retained as-is (no disposition forge,
 * no findings array rewrite). Recognition only for recording/settlement callers.
 */
export function projectLawfulNotaryOutput(value: unknown): NotaryOutput | undefined {
  // #836: no field drop
  return (typeof value === "object" && value !== null && !Array.isArray(value))
    ? (value as NotaryOutput)
    : undefined;
}

/** Retain submitted Notary params as-is for the failure channel (no shape rewrite). */
export function retainNotarySubmission(value: unknown): unknown {
  if (value === undefined) return { missing: "arguments" as const };
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/**
 * Settlement/recording path: only lawful recorded converged/continue/escalate.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedNotaryOutput(value: unknown): NotaryOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Notary output is not an object");
  }
  return value as NotaryOutput;
}
