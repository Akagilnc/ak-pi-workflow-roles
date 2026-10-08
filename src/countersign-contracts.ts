/**
 * Public Countersign (给事中) terminating receipt contracts.
 * Lawful verdicts: converged (署) | continue (封驳) | escalate (上呈).
 * (#572 / ADR 0074) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

import { REVIEW_QUEUE_STATUSES, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "./review-submission.ts";
import { isRecord } from "./unknown-value.ts";

export const COUNTERSIGN_OUTPUT_TOOL_NAME = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;

/**
 * #1195 durable custom entry: nested 符宝郎 terminal (署|上呈) for seat settlement
 * projection on 给事中. Receipt bytes stay original; nested runId rides beside them.
 * Parallel to SECRETARIAT_GATE_OFFICER_ENTRY_TYPE (#969).
 */
export const COUNTERSIGN_GATE_OFFICER_ENTRY_TYPE =
  "ak-countersign-gate-officer" as const;

/** Decisive-facts key for nested 符宝郎 terminal on public Countersign settlement. */
export const COUNTERSIGN_NOTARY_TERMINAL_FACT_KEY = "notaryTerminal" as const;

export type CountersignNotaryTerminalFact = {
  /** Officer receipt original bytes — never rewritten. */
  readonly receipt: unknown;
  /** Nested 符宝郎 runId when known. */
  readonly runId?: string;
};

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
  if (!isRecord(verdict)) {
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
  if (REVIEW_QUEUE_STATUSES.has(status)) {
    return verdict as CountersignVerdict;
  }
  throw new Error("Countersign verdict has no execution discriminator");
}
