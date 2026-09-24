import { reviewSubmissionSchema } from "./review-submission.ts";
import {
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  validateRecordedCountersignOutput,
  type CountersignVerdict,
} from "./countersign-contracts.ts";

export { COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.ts";
export type { CountersignVerdict };

// #836 r16 class 1: fix/note/decisionGate are LLM/human-read narrative content —
// no code branches on their length or nested presence. `status` alone is the
// machine discriminator the queue reads.
// #1055: the three-state field is an enum+required host generation constraint
// on reviewSubmissionSchema. Package execute still does not reject; an unreadable
// value reasks the countersign itself with the received value.
/** 给事中票庭审读五问的交卷形状（ADR 0074）；形状指引，非 schema 闸。 */
export const countersignVerdictSchema = reviewSubmissionSchema;
export type CountersignVerdictParameters = import("./review-submission.ts").ReviewSubmission;

export type CountersignRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配（注册、activate、prompt 注入、singleton 检查、
 * terminate）归注册信封 owner——src/role-runtime.ts（ADR 0018 / #572 R2 判词）。
 */
export const COUNTERSIGN_TOOL_SPEC = {
  name: COUNTERSIGN_OUTPUT_TOOL_NAME,
  label: "给事中输出",
  description: "给事中决议。",
  promptSnippet: "给事中决议",
  parameters: countersignVerdictSchema,
} as const;
