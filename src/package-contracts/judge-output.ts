/** Package-owned Judge output leaf — no role registration surface. */

import {
  seatFallbackBaseStatus,
  seatFallbackStatusHasLawfulEvidence,
  type SeatFallbackTaintedStatus,
  type WithEngineLaborFallback,
} from "../engine-labor-fallback.ts";

export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const JUDGE_ACCEPTED_TEXT = "Judge verdict accepted";

export type JudgeClass = {
  name: string;
  owner: string;
  boundary: string;
  disposition: string;
};

type JudgeVerdictClean =
  | { judgeStatus: "converged"; note?: string; evidence?: unknown }
  | {
    judgeStatus: "continue";
    fix: { summary: string };
    classes: JudgeClass[];
    note?: string;
    evidence?: unknown;
  }
  | {
    judgeStatus: "escalate";
    decisionGate: { question: string; options: string[] };
    note?: string;
    evidence?: unknown;
  };

/** Clean submission shape or seat-fallback tainted accepted receipt (ADR 0071). */
export type JudgeVerdict =
  | JudgeVerdictClean
  | WithEngineLaborFallback<JudgeVerdictClean>;

export function validateAcceptedJudgeDetails(verdict: unknown): JudgeVerdict {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) throw new Error("Judge verdict has no execution discriminator");
  let judgeStatus: unknown;
  try {
    judgeStatus = (verdict as Record<string, unknown>).judgeStatus;
  } catch {
    throw new Error("Judge verdict has no execution discriminator");
  }
  if (typeof judgeStatus !== "string") {
    throw new Error("Judge verdict has no execution discriminator");
  }
  const base = seatFallbackBaseStatus(judgeStatus) as SeatFallbackTaintedStatus<
    "converged" | "continue" | "escalate"
  >;
  if (
    ["converged", "continue", "escalate"].includes(base) &&
    seatFallbackStatusHasLawfulEvidence(judgeStatus, verdict)
  ) {
    return verdict as JudgeVerdict;
  }
  throw new Error("Judge verdict has no execution discriminator");
}
