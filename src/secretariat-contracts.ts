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
/**
 * #969 durable custom entry: 给事中 terminal (署|上呈) for seat settlement projection.
 * Carries original receipt bytes + nested runId. Envelope persists custom entries
 * (not toolResult rows) — headless/ACP safe. Single authority for public terminal
 * officer projection (pass and escalate share this entry).
 */
export const SECRETARIAT_GATE_OFFICER_ENTRY_TYPE =
  "ak-secretariat-gate-officer" as const;

/** Decisive-facts key for nested 给事中 terminal on public Secretariat settlement. */
export const SECRETARIAT_COUNTERSIGN_TERMINAL_FACT_KEY = "countersignTerminal" as const;

export type SecretariatCountersignTerminalFact = {
  /** Officer receipt original bytes — never rewritten. */
  readonly receipt: unknown;
  /** Nested 给事中 runId when known. */
  readonly runId?: string;
};

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
