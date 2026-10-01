/** Package-owned independent Coder and Fixer output leaves. */

import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import {
  FIXER_OUTPUT_TOOL_NAME,
  fixerOutputSchema,
  PARTIALLY_COMPLETED_DEFINITION,
  validateFixerOutput,
  type FixerBlocker,
  type FixerClassResult,
  type FixerOutput,
  type FixerPhase,
} from "./fixer-output.ts";
import { fixerPrerequisiteSchema, fixerPrerequisitesSchema, parseFixerPrerequisites, validateFixerPrerequisites } from "./fixer-packet.ts";
import type { FixerInvocationInput, FixerPrerequisite } from "./fixer-packet.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export {
  FIXER_OUTPUT_TOOL_NAME,
  fixerOutputSchema,
  validateFixerOutput,
  fixerPrerequisiteSchema,
  fixerPrerequisitesSchema,
  parseFixerPrerequisites,
  validateFixerPrerequisites,
};
export type {
  FixerBlocker,
  FixerClassResult,
  FixerOutput,
  FixerPhase,
  FixerInvocationInput,
  FixerPrerequisite,
};

export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export type WorkerRoleLabel = "Coder" | "Fixer";
export type CoderOutput =
  | { status: "planned"; report: string }
  | { status: "completed" | "refused" | "partially_completed"; report: string }
  | { status: "unfinished"; report: string; remainingScope: string; reason?: string };
export type WorkerOutput = CoderOutput | FixerOutput;

export function validateAcceptedCoderDetails(output: unknown): CoderOutput {
  return output as CoderOutput;
}

/** Structural production validator for an accepted current leaf. */
export function validateAcceptedWorkerDetails(output: unknown, roleLabel: WorkerRoleLabel = "Coder"): WorkerOutput {
  return roleLabel === "Fixer" ? validateFixerOutput(output) : validateAcceptedCoderDetails(output);
}

// status 的合法词写在 description。WORKER_DONE_STATUSES 只让 completed /
// partially_completed 进入提交闸。unfinished 且未见理由说明时，运行时同 run 催全
// （ADR 0050）；理由在不在不按 JSON 类型判，也不在派发前用长度拒收。
// report / remainingScope / reason 的声明只留字段名和语义。
const CODER_STATUS_DESCRIPTION =
  `planned | completed | refused | partially_completed | unfinished。unfinished：缺前置或违宪约束致本局未完成。${PARTIALLY_COMPLETED_DEFINITION}` as const;
const coderOutputObject = Type.Object({
  status: Type.Unknown({ description: CODER_STATUS_DESCRIPTION }),
  report: Type.Unknown({ description: "如实结果报告" }),
  remainingScope: Type.Unknown({ description: "本局后剩余工作" }),
  reason: Type.Unknown({
    description: "阻断原因：缺前置或违宪约束。缺待决 owner 决定或答复属缺前置。",
  }),
});
export const coderOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(coderOutputObject),
);
