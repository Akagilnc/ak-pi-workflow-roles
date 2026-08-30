import { StringEnum } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Type } from "typebox";

import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import {
  COUNTERSIGN_ACCEPTED_TEXT,
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  validateRecordedCountersignOutput,
  type CountersignVerdict,
} from "./countersign-contracts.ts";

export { COUNTERSIGN_ACCEPTED_TEXT, COUNTERSIGN_OUTPUT_TOOL_NAME };
export type { CountersignVerdict };

/** 给事中票庭审读五问的交卷形状（ADR 0074）；形状指引，非 schema 闸。 */
export const countersignVerdictSchema = withInfrastructureFailureDeclaration(
  Type.Object(
    {
      countersignStatus: StringEnum(["converged", "continue", "escalate"] as const, { description: "converged（署）| continue（封驳）| escalate（上呈）— 形状指引，非 schema 闸" }),
      fix: Type.Optional(
        Type.Object(
          { summary: Type.String({ minLength: 1, description: "封驳时的退回摘要" }) },
          { additionalProperties: false, description: "封驳时的退回说明" },
        ),
      ),
      note: Type.Optional(Type.String({ minLength: 1, description: "可选裁决附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存的裁决证据" })),
      decisionGate: Type.Optional(
        Type.Object(
          {
            question: Type.String({ minLength: 1 }),
            options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          },
          { additionalProperties: false, description: "需陛下处置的问题与选项" },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);
(countersignVerdictSchema as unknown as { required: string[] }).required = [];

export type CountersignVerdictParameters = Static<typeof countersignVerdictSchema>;

export function validateCountersignVerdict(verdict: CountersignVerdictParameters): CountersignVerdict {
  return validateRecordedCountersignOutput(verdict);
}

export type CountersignRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

export type CountersignHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never;
};

/**
 * 决定工具规格。生命周期装配（注册、activate、prompt 注入、inventory 检查）
 * 归注册信封 owner——src/role-runtime.ts（ADR 0018 / #572 判词送修 3）。
 */
export const COUNTERSIGN_TOOL_SPEC = {
  name: COUNTERSIGN_OUTPUT_TOOL_NAME,
  label: "给事中输出",
  description: "提交票庭审读五问的 typed 署/封驳/上呈决议。",
  promptSnippet: "提交给事中决议",
  parameters: countersignVerdictSchema,
} as const;

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { failOnInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

/** 决定工具执行体：infra 声明→唯一交卷→识别三态→接受（原卷保真）。 */
export function submitCountersignVerdict(
  parameters: unknown,
  toolCallId: string,
  ctx: ExtensionContext,
  hostActions: CountersignHostActions,
): AgentToolResult<unknown> {
  failOnInfrastructureFailureDeclaration(parameters, hostActions, ctx, toolCallId);
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("给事中回执非唯一终局工具调用");
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== COUNTERSIGN_OUTPUT_TOOL_NAME) {
    throw new Error("给事中回执非唯一终局工具调用");
  }
  const verdict = validateCountersignVerdict(parameters as CountersignVerdictParameters);
  return {
    content: [{ type: "text" as const, text: COUNTERSIGN_ACCEPTED_TEXT }],
    details: verdict,
    terminate: true as const,
  };
}
