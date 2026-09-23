/**
 * Public Countersign (给事中) terminating receipt contracts.
 * Lawful verdicts: converged (署) | continue (封驳) | escalate (上呈).
 * (#572 / ADR 0074) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "./review-submission.ts";

export const COUNTERSIGN_OUTPUT_TOOL_NAME = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;

export type CountersignVerdict =
  | { status: "converged"; note?: string; evidence?: unknown }
  | {
    status: "continue";
    fix?: { summary: string };
    note?: string;
    evidence?: unknown;
  }
  | {
    status: "escalate";
    decisionGate?: { question: string; options: string[] };
    note?: string;
    evidence?: unknown;
  };

export function validateRecordedCountersignOutput(verdict: unknown): CountersignVerdict {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("Countersign verdict has no execution discriminator");
  }
  let status: unknown;
  try {
    status = (verdict as Record<string, unknown>).status;
  } catch {
    throw new Error("Countersign verdict has no execution discriminator");
  }
  if (typeof status !== "string") {
    throw new Error("Countersign verdict has no execution discriminator");
  }
  if (["converged", "continue", "escalate"].includes(status)) {
    return verdict as CountersignVerdict;
  }
  throw new Error("Countersign verdict has no execution discriminator");
}
