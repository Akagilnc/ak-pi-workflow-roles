/** Package-owned Judge output leaf — no role registration surface. */


export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const JUDGE_ACCEPTED_TEXT = "大理寺回执已接受";
export const JUDGE_ACCEPTED_AUDIT_NO_RECEIPT_TEXT = "大理寺回执已接受；审计无回执";
export const JUDGE_ACCEPTED_AUDIT_UNREADABLE_TEXT = "大理寺回执已接受；审计形状不可读";

export type JudgeClass = {
  name: string;
  owner: string;
  boundary: string;
  disposition: string;
};

export type JudgeVerdict =
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
  if (
    ["converged", "continue", "escalate"].includes(judgeStatus)
  ) {
    return verdict as JudgeVerdict;
  }
  throw new Error("Judge verdict has no execution discriminator");
}
