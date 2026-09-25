import type { Static } from "typebox";
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";
import {
  DIARIST_OUTPUT_TOOL_NAME,
  validateRecordedDiaristOutput,
  type DiaristOutput,
} from "./diarist-contracts.ts";

export {
  DIARIST_OUTPUT_TOOL_NAME,
} from "./diarist-contracts.ts";
export type { DiaristOutput };
export { validateRecordedDiaristOutput };

/**
 * 起居郎交卷形状。
 * #901：交边界（sessions）；正文与不可解析原字节由机械投影。
 */
export const diaristOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "completed | escalate",
      }),
      ticketNumber: Type.Optional(
        Type.Unknown({
          description:
            "本庭对象票号（正整数）或 null/省略＝真无票；下游走 typed 键；认不出用 status=escalate，不洗成无录。机械层不重判。",
        }),
      ),
      courtTicketNumbers: Type.Optional(
        Type.Unknown({
          description:
            "#871 本次合审应各自成录的票号集合（正整数数组，含主票）；单票可省略。机械层只做类型/去重投影，不从散文猜票。",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "status 为 escalate 时：认不出本庭对象的原因",
        }),
      ),
      sessions: Type.Optional(
        Type.Array(
          Type.Object(
            {
              path: Type.Optional(
                Type.String({ description: "会话卷绝对或可读路径" }),
              ),
              ranges: Type.Optional(
                Type.Array(
                  Type.Object(
                    {
                      from: Type.Optional(
                        Type.Object(
                          {
                            id: Type.Optional(Type.String()),
                            line: Type.Optional(Type.Unknown()),
                          },
                          {
                            additionalProperties: true,
                            description: "起点：原生 id 或本轮行号二选一",
                          },
                        ),
                      ),
                      to: Type.Optional(
                        Type.Object(
                          {
                            id: Type.Optional(Type.String()),
                            line: Type.Optional(Type.Unknown()),
                          },
                          {
                            additionalProperties: true,
                            description: "终点：原生 id 或本轮行号二选一",
                          },
                        ),
                      ),
                    },
                    { additionalProperties: true, description: "一段对话区间" },
                  ),
                  { description: "本卷本轮各区间；至少一段" },
                ),
              ),
            },
            { additionalProperties: true, description: "一卷会话的边界" },
          ),
          {
            description:
              "本票对话边界；空列表＝本轮无对话可划。端点无法指名时走 reask，不中止。",
          },
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
  description:
    "起居郎交本票对话边界（sessions）；认不出本庭对象则 escalate。",
  promptSnippet: "起居郎交边界",
  parameters: diaristOutputSchema,
} as const;
