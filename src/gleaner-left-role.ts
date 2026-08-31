import type { Static } from "typebox";
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  validateRecordedGleanerLeftOutput,
  type GleanerLeftOutput,
} from "./gleaner-left-contracts.ts";

export {
  GLEANER_LEFT_ACCEPTED_TEXT,
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
} from "./gleaner-left-contracts.ts";
export type { GleanerLeftOutput };
export { validateRecordedGleanerLeftOutput };

/** 左拾遗弹章交卷形状；形状指引，非 schema 闸。 */
export const gleanerLeftOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "completed — 形状指引，非 schema 闸",
      }),
      findings: Type.Array(
        Type.Object(
          {
            pointer: Type.String({ description: "文件/行指针" }),
            statement: Type.String({ description: "疑点陈述" }),
          },
          { additionalProperties: true, description: "一条弹章" },
        ),
        { description: "弹章列表；空列表合法完局" },
      ),
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
