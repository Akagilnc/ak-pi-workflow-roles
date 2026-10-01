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
 * status 的合法词（completed | escalate）写在 description，结算认这些词。
 * sessions / ticketSessions 是投影所读的边界：卷路径或端点读不出时走既有 reask，不中止本轮。
 * 声明只留字段名和语义说明，不留类型、嵌套、长度、必填。
 */
const DIARIST_SESSIONS_DESCRIPTION =
  "对话边界。每卷含 path（会话卷绝对或可读路径）与 ranges（本卷本轮各区间）。每段区间含 from / to；起点与终点各写 id（原生 id）或 line（本轮行号），二选一。空列表＝本轮无对话可划。端点无法指名时走 reask，不中止。" as const;

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
      reason: Type.Unknown({
        description: "status 为 escalate 时：认不出本庭对象的原因",
      }),
      sessions: Type.Optional(Type.Unknown({ description: DIARIST_SESSIONS_DESCRIPTION })),
      ticketSessions: Type.Unknown({
        description: `多票庭逐票对话边界；每票含 ticketNumber（本条边界所归票号，正整数）与 sessions（${DIARIST_SESSIONS_DESCRIPTION}）。一次交卷各票各自分录。与单票 sessions 二选一。`,
      }),
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
    "起居郎交单票 sessions 或多票逐票 ticketSessions 边界；认不出本庭对象则 escalate。",
  promptSnippet: "起居郎交边界",
  parameters: diaristOutputSchema,
} as const;
