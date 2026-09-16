/**
 * Public Secretariat (中书省) terminating receipt contracts.
 * Verdict domain: converged (署) | continue (封驳) | escalate (上呈).
 * (#924) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

export const SECRETARIAT_OUTPUT_TOOL_NAME = "ak_secretariat_output";
export const SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME =
  "ak_secretariat_summon_countersign";
export const SECRETARIAT_ACCEPTED_TEXT = "中书省回执已接受";

export type SecretariatVerdict =
  | {
      secretariatStatus: "converged";
      ticketNumber?: number;
      note?: string;
      evidence?: unknown;
    }
  | {
      secretariatStatus: "continue";
      note?: string;
      evidence?: unknown;
    }
  | {
      secretariatStatus: "escalate";
      decisionGate?: { question: string; options: string[] };
      note?: string;
      evidence?: unknown;
    };
