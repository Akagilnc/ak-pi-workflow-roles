/**
 * Public Inspector (台院) terminating receipt contracts.
 * Lawful explicit releases: converged | continue | escalate.
 * Dual path: gate-dispatched and independently callable (#568 / ADR 0074).
 */

import { REVIEW_SUBMISSION_OUTPUT_TOOL_NAME } from "./review-submission.ts";

export const INSPECTOR_OUTPUT_TOOL_NAME: string = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;
export const INSPECTOR_SOURCE_RUN_FLAG = {
  name: "ak-inspector-source-run",
  definition: {
    description: "台院初铸绑定的父 run 绝对路径",
    type: "string" as const,
  },
} as const;

export type InspectorOutput =
  | { readonly status: "converged"; readonly findings?: unknown }
  | { readonly status: "continue"; readonly findings?: unknown }
  | { readonly status: "escalate"; readonly reason?: unknown; readonly findings?: unknown };
