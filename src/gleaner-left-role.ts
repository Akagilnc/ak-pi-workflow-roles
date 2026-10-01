import type { Static } from "typebox";
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";
import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  validateRecordedGleanerLeftOutput,
  type GleanerLeftOutput,
} from "./gleaner-left-contracts.ts";

export {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
} from "./gleaner-left-contracts.ts";
export type { GleanerLeftOutput };
export { validateRecordedGleanerLeftOutput };

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

export type GleanerLeftOutputParameters = Static<typeof gleanerLeftOutputSchema>;

export type GleanerLeftRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 */
export const GLEANER_LEFT_TOOL_SPEC = {
  name: GLEANER_LEFT_OUTPUT_TOOL_NAME,
  label: "左拾遗输出",
  description: "左拾遗弹章。",
  promptSnippet: "左拾遗弹章",
  parameters: gleanerLeftOutputSchema,
} as const;
