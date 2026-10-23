import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";
import type { CountersignVerdict } from "./countersign-contracts.ts";

export { COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.ts";
export type { CountersignVerdict };

// #836 r16 class 1: fix/note/decisionGate are LLM/human-read narrative content —
// no code branches on their length or nested presence. `status` alone is the
// machine discriminator the queue reads.
// #1055: the three-state field is an enum+required host generation constraint.
export type CountersignVerdictParameters = import("./review-submission.ts").ReviewSubmission;

export type CountersignRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配（注册、activate、prompt 注入、singleton 检查、
 * terminate）归注册信封 owner——src/role-runtime.ts（ADR 0018 / #572 R2 判词）。
 */
export const COUNTERSIGN_TOOL_SPEC = roleSubmissionDeclaration("countersign");
