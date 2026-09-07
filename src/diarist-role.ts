import type { Static } from "typebox";
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import {
  DIARIST_OUTPUT_TOOL_NAME,
  validateRecordedDiaristOutput,
  type DiaristOutput,
} from "./diarist-contracts.ts";

export {
  DIARIST_ACCEPTED_TEXT,
  DIARIST_OUTPUT_TOOL_NAME,
} from "./diarist-contracts.ts";
export type { DiaristOutput };
export { validateRecordedDiaristOutput };

/** 起居郎交卷形状；形状指引，非 schema 闸。 */
export const diaristOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "completed — 形状指引，非 schema 闸",
      }),
      selections: Type.Array(
        Type.Object(
          {
            candidateIndex: Type.Number({ description: "候选目录中的整块序号" }),
            quotes: Type.Array(Type.String(), {
              description: "该块 transcript 内的连续原文；机械反验",
            }),
            note: Type.Optional(
              Type.String({ description: "该材料与本案的关系（人读）" }),
            ),
          },
          { additionalProperties: true, description: "一条入录选择" },
        ),
        { description: "入录选择；空列表合法完局" },
      ),
    }),
  ),
);

export type DiaristOutputParameters = Static<typeof diaristOutputSchema>;

export type DiaristRuntimeDependencies = {
  loadSoul(): Promise<string>;
};

/**
 * 决定工具规格。生命周期装配归注册信封 owner——src/role-runtime.ts（ADR 0018）。
 */
export const DIARIST_TOOL_SPEC = {
  name: DIARIST_OUTPUT_TOOL_NAME,
  label: "起居郎输出",
  description: "起居郎入录选择。",
  promptSnippet: "起居郎入录选择",
  parameters: diaristOutputSchema,
} as const;
