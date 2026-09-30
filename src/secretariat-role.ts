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

/**
 * 中书省终局回执形状。
 * #1134: `secretariatStatus` alone is the trajectory field
 * (src/packaged-role-registry.ts:406 receiptStatusKey; the public settlement reads
 * converged | escalate to route); its words ride the description. note/evidence/
 * decisionGate are declared name + semantic description only — the string type, the
 * number type, the nested question/options object shape and the required constraint
 * are deleted, because the package declaration IS the host's pre-dispatch validator.
 * (ticketNumber keeps its own declaration: it is the declared seat identity the
 * activation flag and settlement read, not narrative content.)
 */
export const secretariatVerdictSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      secretariatStatus: Type.Unknown({
        description: "converged | escalate",
      }),
      ticketNumber: Type.Optional(
        Type.Unknown({ description: "本票号；署时指向最终正文所在票" }),
      ),
      note: Type.Unknown({ description: "附注" }),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Unknown({
        description: "需陛下处置的问题与选项；可写 question 与 options，原样留存。",
      }),
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
