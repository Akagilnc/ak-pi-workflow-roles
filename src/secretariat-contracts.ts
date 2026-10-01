/**
 * Public Secretariat (中书省) terminating receipt contracts.
 * Public terminal domain: converged (署) | escalate (上呈).
 * A countersign continue is an internal rewrite-and-resubmit fact, not a
 * Secretariat terminal.
 * (#924) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

import { Type } from "typebox";

import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const SECRETARIAT_OUTPUT_TOOL_NAME = "ak_secretariat_output";

/**
 * 中书省终局回执形状。
 * #1134: `secretariatStatus` alone is the trajectory field
 * (src/packaged-role-registry.ts receiptStatusKey; the public settlement reads
 * converged | escalate to route); its words ride the description. note/evidence/
 * decisionGate are declared name + semantic description only — the string type, the
 * number type, the nested question/options object shape and the required constraint
 * are deleted, because the package declaration IS the host's pre-dispatch validator.
 * (ticketNumber keeps its own declaration: it is the declared seat identity the
 * activation flag and settlement read, not narrative content.)
 */
export const secretariatVerdictSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      secretariatStatus: Type.Unknown({
        description: "converged | escalate",
      }),
      ticketNumber: Type.Optional(
        Type.Unknown({ description: "本票号；署时指向最终正文所在票" }),
      ),
      note: Type.Unknown({ description: "附注" }),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Unknown({
        description: "需陛下处置的问题与选项；可写 question 与 options，原样留存。",
      }),
    },
    { additionalProperties: true },
  ),
);
(secretariatVerdictSchema as unknown as { required: string[] }).required = [];
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
