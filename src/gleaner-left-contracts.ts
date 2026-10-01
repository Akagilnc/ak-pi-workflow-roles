/**
 * Public Gleaner-Left (左拾遗) terminating receipt contracts.
 * Lawful explicit release: completed, with empty or nonempty 弹章.
 * No bounce / verdict channel (言不为狱). 原卷保真 (ADR 0055).
 */

import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const GLEANER_LEFT_OUTPUT_TOOL_NAME = "ak_gleaner_left_output";

// #836 r16 class 1: pointer/statement are LLM/human-read narrative content — no
// code branches on their presence.
// #1134: `status` alone is the trajectory field (src/gleaner-left-contracts.ts:38
// recognizes completed to settle); its word rides the description. findings is
// narrative content declared name + semantic description only — the array type
// and the nested pointer/statement object shape are deleted, because the package
// declaration IS the host's pre-dispatch validator. An empty findings list stays
// a lawful completion; an omitted one is now expressible too.
export const gleanerLeftOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "completed",
      }),
      findings: Type.Unknown({
        description:
          "弹章列表；每条可含 pointer（文件/行指针）与 statement（疑点陈述），原样留存。空列表合法完局；机器不判弹章是否成立。",
      }),
    }),
  ),
);

/** Internal transport: comparison-base revision for the unanchored merge-candidate diff. */
export const GLEANER_LEFT_BASE_FLAG = {
  name: "ak-gleaner-left-base",
  definition: {
    description: "Fixed comparison-base revision for the unanchored merge-candidate diff",
    type: "string" as const,
  },
} as const;

export type GleanerLeftFinding = {
  readonly pointer: string;
  readonly statement: string;
};

export type GleanerLeftOutput = {
  readonly status: "completed";
  readonly findings: readonly GleanerLeftFinding[];
};

export function validateRecordedGleanerLeftOutput(value: unknown): GleanerLeftOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gleaner-left output has no execution discriminator");
  }
  let status: unknown;
  try {
    status = (value as Record<string, unknown>).status;
  } catch {
    throw new Error("Gleaner-left output has no execution discriminator");
  }
  if (status === "completed") {
    return value as GleanerLeftOutput;
  }
  throw new Error("Gleaner-left output has no execution discriminator");
}

