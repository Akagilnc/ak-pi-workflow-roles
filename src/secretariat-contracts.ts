/**
 * Public Secretariat (中书省) terminating receipt contracts.
 * Public terminal domain: converged (署) | escalate (上呈).
 * A countersign continue is an internal rewrite-and-resubmit fact, not a
 * Secretariat terminal.
 * (#924) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

export const SECRETARIAT_OUTPUT_TOOL_NAME = "ak_secretariat_output";
export const SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME =
  "ak_secretariat_summon_countersign";
export const SECRETARIAT_ACCEPTED_TEXT = "中书省回执已接受";
/**
 * #969 durable custom entry: 给事中上呈 receipt for seat settlement projection.
 * Envelope persists custom entries (not toolResult rows) — headless/ACP safe.
 */
export const SECRETARIAT_GATE_ESCALATE_ENTRY_TYPE =
  "ak-secretariat-gate-escalate" as const;

export type SecretariatVerdict =
  | {
      secretariatStatus: "converged";
      ticketNumber?: number;
      note?: string;
      evidence?: unknown;
    }
  | {
      secretariatStatus: "escalate";
      decisionGate?: { question: string; options: string[] };
      note?: string;
      evidence?: unknown;
    };
