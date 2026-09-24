/**
 * Secretariat (中书省) label and terminating decision-tool spec.
 * Lifecycle assembly (activate, register, prompt inject, inventory) lives on the
 * shared envelope — src/role-runtime.ts (ADR 0018 / #924).
 */
import type { Static } from "typebox";
import { Type } from "typebox";

import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME, type SecretariatVerdict } from "./secretariat-contracts.ts";

export { SECRETARIAT_OUTPUT_TOOL_NAME } from "./secretariat-contracts.ts";
export type { SecretariatVerdict };

/** 中书省终局回执形状。 */
export const secretariatVerdictSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      secretariatStatus: Type.Unknown({
        description: "converged | escalate",
      }),
      ticketNumber: Type.Optional(
        Type.Number({ description: "本票号；署时指向最终正文所在票" }),
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
(secretariatVerdictSchema as unknown as { required: string[] }).required = [];

export type SecretariatVerdictParameters = Static<typeof secretariatVerdictSchema>;

export const SECRETARIAT_OUTPUT_TOOL_SPEC = {
  name: SECRETARIAT_OUTPUT_TOOL_NAME,
  label: "中书省输出",
  description: "中书省终局回执。",
  promptSnippet: "中书省终局回执",
  parameters: secretariatVerdictSchema,
} as const;

export type SecretariatRuntimeDependencies = {
  loadSoul(): Promise<string>;
};
