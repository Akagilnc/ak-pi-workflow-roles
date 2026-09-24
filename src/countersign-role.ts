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
// #836 (2026-09-11 御批 / ADR 0003 Amendment): registered-to-provider closed
// value domains reject an unknown status before the submission
// ledger ever records it, defeating 读不出三态→resume 说话者本人. Kept open
// (Type.Unknown) like every other gate-queue status field in this package
// (notary/auditor/gatekeeper/navigator); src/role-runtime.ts:997-1025 still
// classifies the recorded value and reasks the countersign itself when it
// isn't one of the three states — code, not the transport, does that work.
/** 给事中票庭审读五问的交卷形状（ADR 0074）。 */
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
