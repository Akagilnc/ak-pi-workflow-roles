/**
 * Public Countersign (给事中) terminating receipt contracts.
 * Lawful verdicts: converged (署) | continue (封驳) | escalate (上呈).
 * (#572 / ADR 0074) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

export const COUNTERSIGN_OUTPUT_TOOL_NAME = "ak_countersign_output";
export const COUNTERSIGN_ACCEPTED_TEXT = "给事中回执已接受";

export type CountersignVerdict =
  | { countersignStatus: "converged"; note?: string; evidence?: unknown }
  | {
    countersignStatus: "continue";
    fix?: { summary: string };
    note?: string;
    evidence?: unknown;
  }
  | {
    countersignStatus: "escalate";
    decisionGate?: { question: string; options: string[] };
    note?: string;
    evidence?: unknown;
  };

export function validateRecordedCountersignOutput(verdict: unknown): CountersignVerdict {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new Error("Countersign verdict has no execution discriminator");
  }
  let countersignStatus: unknown;
  try {
    countersignStatus = (verdict as Record<string, unknown>).countersignStatus;
  } catch {
    throw new Error("Countersign verdict has no execution discriminator");
  }
  if (typeof countersignStatus !== "string") {
    throw new Error("Countersign verdict has no execution discriminator");
  }
  if (["converged", "continue", "escalate"].includes(countersignStatus)) {
    return verdict as CountersignVerdict;
  }
  throw new Error("Countersign verdict has no execution discriminator");
}
