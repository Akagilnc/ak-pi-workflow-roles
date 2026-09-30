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
 * #1134: `status` alone is the trajectory field (src/diarist-contracts.ts:55
 * recognizes completed | escalate to settle); its words ride the description.
 * reason/sessions/ticketSessions are declared name + semantic description only —
 * the string type, the nested session/range/from/to object shapes and the array
 * types are deleted, because the package declaration IS the host's pre-dispatch
 * validator. The mechanical projection below still parses whatever shape arrives
 * (projectDiaristSessions / projectDiaristTicketSessions, #901 reask-not-explode).
 */
const DIARIST_SESSIONS_DESCRIPTION =
  "对话边界；每卷一节，每节含若干区间，每区间含 from / to 起点终点（原生 id 或本轮行号二选一）。空列表＝本轮无对话可划。端点无法指名时走 reask，不中止。" as const;

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
        description: `多票庭逐票对话边界；每票含 ticketNumber 与其 ${DIARIST_SESSIONS_DESCRIPTION}一次交卷各票各自分录。与单票 sessions 二选一。`,
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
