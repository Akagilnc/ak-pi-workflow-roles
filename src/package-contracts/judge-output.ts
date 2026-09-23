/** Package-owned Judge output leaf — no role registration surface. */


import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "../review-submission.ts";

export const JUDGE_OUTPUT_TOOL_NAME: string = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;

export type JudgeClass = {
  name: string;
  owner: string;
  boundary: string;
  disposition: string;
};

export type JudgeVerdict =
  | { status: "converged"; note?: string; evidence?: unknown }
  | {
    status: "continue";
    fix: { summary: string };
    classes: JudgeClass[];
    note?: string;
    evidence?: unknown;
  }
  | {
    status: "escalate";
    decisionGate: { question: string; options: string[] };
    note?: string;
    evidence?: unknown;
  };

export function validateAcceptedJudgeDetails(verdict: unknown): JudgeVerdict {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) throw new Error("Judge verdict has no execution discriminator");
  let status: unknown;
  try {
    status = (verdict as Record<string, unknown>).status;
  } catch {
    throw new Error("Judge verdict has no execution discriminator");
  }
  if (typeof status !== "string") {
    throw new Error("Judge verdict has no execution discriminator");
  }
  if (
    ["converged", "continue", "escalate"].includes(status)
  ) {
    return verdict as JudgeVerdict;
  }
  throw new Error("Judge verdict has no execution discriminator");
}
