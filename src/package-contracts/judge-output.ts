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
