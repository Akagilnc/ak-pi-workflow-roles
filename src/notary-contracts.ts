/**
 * Public Notary (符宝郎) terminating receipt contracts.
 * Lawful explicit releases: converged | continue | escalate.
 * No usable result is infrastructure failure via public settlement, not a judgment status (#475).
 */
import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "./review-submission.ts";

import { isRecord } from "./unknown-value.ts";

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

/**
 * Settlement/recording path: only lawful recorded converged/continue/escalate.
 * Does not gate role admission — callers must not use this to reject a submission.
 */
export function validateRecordedNotaryOutput(value: unknown): NotaryOutput {
  if (!isRecord(value)) {
    throw new Error("Notary output is not an object");
  }
  return value as NotaryOutput;
}
