import type { Static } from "typebox";
import { Type } from "typebox";

import { stringEnum } from "./host-contracts.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import {
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  validateRecordedCountersignOutput,
  type CountersignVerdict,
} from "./countersign-contracts.ts";

export { COUNTERSIGN_ACCEPTED_TEXT, COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.ts";
export type { CountersignVerdict };

// #836 r16 class 1: fix/note/decisionGate are LLM/human-read narrative content —
// no code branches on their length or nested presence. `countersignStatus`
// alone is the machine discriminator the queue reads (src/role-runtime.ts:979-1025).
/** 给事中票庭审读五问的交卷形状（ADR 0074）；形状指引，非 schema 闸。 */
export const countersignVerdictSchema = withInfrastructureFailureDeclaration(
  Type.Object(
    {
      countersignStatus: stringEnum(["converged", "continue", "escalate"] as const, { description: "converged | continue | escalate。非三态时请重读后重交，勿改标。" }),
      fix: Type.Optional(
        Type.Object(
          { summary: Type.Optional(Type.String({ description: "退回摘要" })) },
          { additionalProperties: true, description: "退回说明" },
        ),
      ),
      note: Type.Optional(Type.String({ description: "附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Optional(
        Type.Object(
          {
            question: Type.Optional(Type.String()),
            options: Type.Optional(Type.Array(Type.String())),
          },
          { additionalProperties: true, description: "需陛下处置的问题与选项" },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);
(countersignVerdictSchema as unknown as { required: string[] }).required = [];

export type CountersignVerdictParameters = Static<typeof countersignVerdictSchema>;

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
