/**
 * Public 起居郎 (diarist) terminating receipt contracts — ADR 0075 `diarist-is-role` / #901.
 * Lawful explicit releases: completed (入录) | escalate (认不出本庭对象上抛).
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
       * Empty / absent = lawful empty selection (no dialogue this turn).
       * Malformed endpoints → accept hook reasks (`reask-not-explode`).
       */
      readonly sessions?: readonly TicketProvenanceSession[];
      /** Per-ticket dialogue bounds for a single multi-ticket summons (#1107). */
      readonly ticketSessions?: readonly {
        readonly ticketNumber: number;
        readonly sessions: readonly TicketProvenanceSession[];
      }[];
    }
  | {
      /** LLM cannot tell which ticket this summons is about — escalate, never wash into 无录. */
      readonly status: "escalate";
      readonly reason: string;
    };

export function validateRecordedDiaristOutput(value: unknown): DiaristOutput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
 * Absent key → empty (lawful). Present but unusable → undefined (caller reasks).
 */
export function projectDiaristSessions(
  value: unknown,
): readonly TicketProvenanceSession[] | undefined {
  const raw = (value as { sessions?: unknown } | null)?.sessions;
  if (raw === undefined) return [];
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
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
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
