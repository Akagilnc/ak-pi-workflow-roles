/**
 * Public 起居郎 (diarist) terminating receipt contracts — ADR 0075 `diarist-is-role` / #901.
 * Lawful explicit releases: completed (入录) | escalate (无法正常署时上呈，见 Soul).
 * Machine facts about the volume come from the mechanical reproject seam, never
 * from model self-report (锚定宪法); this module owns the receipt shape only.
 *
 * #901: LLM submits bounds; the mechanical layer projects source bytes.
 */

import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";
import {
  projectTicketProvenanceSessions,
  type TicketProvenanceSession,
} from "./ticket-provenance-contracts.ts";
import { isSafePositiveTicketNumber } from "./run-ticket-number.ts";
import { isRecord } from "./unknown-value.ts";

export const DIARIST_OUTPUT_TOOL_NAME = "ak_diarist_output";

export type DiaristOutput =
  | {
      readonly status: "completed";
      /**
       * Typed court-target assertion (ADR 0075 `diarist-resolves-ticket-llm-layer`).
       * Positive integer = 本庭对象=票N; null/absent = true-unbound (先录入 unbound).
       * LLM owns recognition; mechanical layer does not re-judge the number.
       */
      readonly ticketNumber?: number | null;
      /**
       * Dialogue bounds: one entry per session volume, each with one or more ranges.
       * Empty / null / absent = lawful empty selection (no dialogue this turn).
       * Malformed endpoints → accept hook reasks (`reask-not-explode`).
       */
      readonly sessions?: readonly TicketProvenanceSession[] | null;
      /** Per-ticket dialogue bounds for a single multi-ticket summons (#1107). */
      readonly ticketSessions?: readonly {
        readonly ticketNumber: number;
        readonly sessions: readonly TicketProvenanceSession[];
      }[];
    }
  | {
      /** LLM cannot sign this round normally (Soul) — escalate, never wash into 无录. */
      readonly status: "escalate";
      readonly reason: string;
    };

export function validateRecordedDiaristOutput(value: unknown): DiaristOutput {
  if (!isRecord(value)) {
    throw new Error("Diarist output has no execution discriminator");
  }
  let status: unknown;
  try {
    status = (value as Record<string, unknown>).status;
  } catch {
    throw new Error("Diarist output has no execution discriminator");
  }
  if (status === "completed" || status === "escalate") {
    return value as DiaristOutput;
  }
  throw new Error("Diarist output has no execution discriminator");
}

/**
 * Project sessions from a completed diarist payload.
 * Null / absent key → empty (lawful). Non-null but unusable → undefined (caller reasks).
 */
export function projectDiaristSessions(
  value: unknown,
): readonly TicketProvenanceSession[] | undefined {
  const raw = (value as { sessions?: unknown } | null)?.sessions;
  if (raw == null) return [];
  return projectTicketProvenanceSessions(raw);
}

/** Present multi-ticket bounds take precedence over the legacy single-ticket sessions. */
export function projectDiaristTicketSessions(
  value: Record<string, unknown>,
): readonly { readonly ticketNumber: number; readonly sessions: readonly TicketProvenanceSession[] }[] | undefined {
  const raw = value.ticketSessions;
  if (!Array.isArray(raw)) return undefined;
  const perTicket = new Map<number, TicketProvenanceSession[]>();
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const { ticketNumber, sessions: rawSessions } = entry as Record<string, unknown>;
    if (!isSafePositiveTicketNumber(ticketNumber)) return undefined;
    const sessions = projectTicketProvenanceSessions(rawSessions);
    if (sessions === undefined) return undefined;
    perTicket.set(ticketNumber, [...(perTicket.get(ticketNumber) ?? []), ...sessions]);
  }
  return Array.from(perTicket, ([ticketNumber, sessions]) => ({ ticketNumber, sessions }));
}

/**
 * 起居郎交卷形状。
 * #901：交边界（sessions）；正文与不可解析原字节由机械投影。
 * status 的合法词（completed | escalate）写在 description，结算认这些词。
 * sessions / ticketSessions 是投影所读的边界：卷路径或端点读不出时走既有 reask，不中止本轮。
 * 声明只留字段名和语义说明，不留类型、嵌套、长度、必填。
 */
export const DIARIST_BOUND_ENDPOINTS =
  "起点与终点各写 id 或 line，二选一：id＝会话卷里那一行 JSON 的 uuid 字段值（没有 uuid 取 id；顶层都没有再取 message 或 payload 里的 uuid / id），同一 id 出现多次时取第一次出现的那一行；line＝那一行在文件里从 1 数起的行号。两端都含在区间内。" as const;

const DIARIST_SESSIONS_DESCRIPTION =
  `对话边界。每卷含 path（会话卷绝对或可读路径）与 ranges（本卷本轮各区间）。每段区间含 from / to；${DIARIST_BOUND_ENDPOINTS}区间里只有说话人的原文进录：用户与助手消息里的文本、真人经队列的插话；思考、工具调用、工具结果和机器通知不进录，区间可以直接跨过它们，不必拆段。每次交卷的边界照投影追加进本票起居录，不去重，也不改已有的录。空列表＝本轮无对话可划。端点无法指名时走 reask，不中止。` as const;

export const diaristOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      status: Type.Unknown({
        description: "completed | escalate",
      }),
      ticketNumber: Type.Optional(
        Type.Unknown({
          description:
            "仅有本庭对象时填票号（正整数）；没有就填 null＝真无票；下游走 typed 键；认不出用 status=escalate，不洗成无录。机械层不重判。",
        }),
      ),
      reason: Type.Unknown({
        description: "仅 status 为 escalate 时填上呈的原因；没有就填 null",
      }),
      sessions: Type.Optional(Type.Unknown({
        description: `仅单票庭时填对话边界；没有就填 null。${DIARIST_SESSIONS_DESCRIPTION}`,
      })),
      ticketSessions: Type.Unknown({
        description: `仅多票庭时填逐票对话边界；没有就填 null。每票含 ticketNumber（本条边界所归票号，正整数）与 sessions（${DIARIST_SESSIONS_DESCRIPTION}）。一次交卷各票各自分录。`,
      }),
    }),
  ),
);
