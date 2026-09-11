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

// #836 r16 class 1: entries[].sourceKind/sourceRef/transcript/timestamp are
// LLM/human-read content — src/ticket-provenance-contracts.ts:130-140 reads
// sourceKind/transcript, but the lawful path on a miss is to keep the entry as
// unprojected raw payload (src/diarist.ts:52-75 never rejects or drops it), so
// provider `required` would cut off that very branch; sourceRef/timestamp are
// not branched on at all.
/** 起居郎交卷形状；形状指引，非 schema 闸。 */
export const diaristOutputSchema = withInfrastructureFailureDeclaration(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "completed | escalate — 形状指引，非 schema 闸",
      }),
      ticketNumber: Type.Optional(
        Type.Unknown({
          description:
            "本庭对象票号（正整数）或 null/省略＝真无票；下游走 typed 键；认不出用 status=escalate，不洗成无录。机械层不重判。",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "status 为 escalate 时：认不出本庭对象的原因",
        }),
      ),
      entries: Type.Optional(
        Type.Array(
          Type.Object(
            {
              sourceKind: Type.Optional(Type.String({
                description:
                  "来源族：cc-session | issue-body-comment | adr-decision-key | ticket-decree-block",
              })),
              sourceRef: Type.Optional(Type.Object(
                {
                  sessionFile: Type.Optional(Type.String()),
                  entryId: Type.Optional(Type.Unknown()),
                  path: Type.Optional(Type.String()),
                  url: Type.Optional(Type.String()),
                },
                { additionalProperties: true, description: "不可变源指针" },
              )),
              transcript: Type.Optional(Type.String({
                description: "整块原文（誊录整块，不指针化）",
              })),
              timestamp: Type.Optional(Type.String({ description: "源时间戳 ISO" })),
              note: Type.Optional(
                Type.String({ description: "该材料与本案的关系（人读）" }),
              ),
            },
            { additionalProperties: true, description: "一条入录整块" },
          ),
          { description: "入录整块；空列表合法完局；escalate 时可不交" },
        ),
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
  description: "起居郎入录整块与本票身份断言；认不出本庭对象则 escalate。",
  promptSnippet: "起居郎入录整块与本票身份",
  parameters: diaristOutputSchema,
} as const;
