/**
 * 起居录（ticket-provenance）typed 形状 —— ADR 0075 / ADR 0081 / #1090。
 *
 * 一册＝一个追加式 records.jsonl。每轮交卷的 `sessions`＝本轮对话边界；
 * 成录接缝按该边界从宿主卷投影并追加，不回读已成录历史去重或折叠。
 * 既有「首行册子头＋裸对话行」snapshot 仍可读；后续提交不回写旧行。
 */

/** Sitian kind for per-ticket court diary volumes. */
export const TICKET_PROVENANCE_KIND = "ticket-provenance" as const;

/** 说话人取值域（`speaker-required`）。 */
export type TicketProvenanceSpeaker = "owner" | "runner";

/**
 * 区间端点：以**原生 id** 或**本轮行号**指名，二选一。
 * 行号一端覆盖整卷不带原生 id 的来源；两者都缺即无法定位，属「输入错了就问」。
 */
export type TicketProvenanceBound = {
  readonly id?: string;
  readonly line?: number;
};

/** 一卷内的一段对话区间。 */
export type TicketProvenanceRange = {
  readonly from: TicketProvenanceBound;
  readonly to: TicketProvenanceBound;
};

/**
 * 一卷：会话卷路径 + 区间声明。
 * 交卷与每条追加提交的 payload.sessions 同型＝该次边界。
 */
export type TicketProvenanceSession = {
  readonly path: string;
  readonly ranges: readonly TicketProvenanceRange[];
};

/** 旧 snapshot 册子头形状（存量可读；#1090 后新提交不再维护折叠头）。 */
export type TicketProvenanceHeader = {
  readonly repo: string;
  readonly ticket: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessions: readonly TicketProvenanceSession[];
};

/**
 * 一条对话（存于不可变投影提交；旧 snapshot 中也可为裸行）。
 * `id` 按源事实存在则记、不存在不编；`s` 为本轮 sessions 下标。
 */
export type TicketProvenanceLine = {
  readonly speaker: TicketProvenanceSpeaker;
  /** 本轮 sessions 下标。 */
  readonly s: number;
  /** Logical source order within the source volume at projection time. */
  readonly sourcePosition?: number;
  /** Replay-invariant structural identity for id-less source rows. */
  readonly sourceIdentity?: string;
  readonly id?: string;
  readonly text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function projectBound(value: unknown): TicketProvenanceBound | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" && value.id !== "" ? value.id : undefined;
  const line = positiveInteger(value.line);
  if (id === undefined && line === undefined) return undefined;
  return { ...(id === undefined ? {} : { id }), ...(line === undefined ? {} : { line }) };
}

/**
 * 投影起居郎交上来的边界。
 * 端点无法指名、卷路径缺失即返回 undefined——调用者据此走既有 reask 请其重交，
 * 不猜、不补、不中止本轮（`reask-not-explode`）。
 */
export function projectTicketProvenanceSessions(
  value: unknown,
): readonly TicketProvenanceSession[] | undefined {
  // Empty array = lawful empty selection (no dialogue ranges this turn).
  // Non-array / malformed member = unusable bounds → caller reasks.
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const sessions: TicketProvenanceSession[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const path = raw.path;
    if (typeof path !== "string" || path.trim() === "") return undefined;
    if (!Array.isArray(raw.ranges) || raw.ranges.length === 0) return undefined;
    const ranges: TicketProvenanceRange[] = [];
    for (const rawRange of raw.ranges) {
      if (!isRecord(rawRange)) return undefined;
      const from = projectBound(rawRange.from);
      const to = projectBound(rawRange.to);
      if (from === undefined || to === undefined) return undefined;
      ranges.push({ from, to });
    }
    sessions.push({ path, ranges });
  }
  return sessions;
}

/** 读回册子头（文件第一行）。形状不成立即 undefined——按无册处理，不猜。 */
export function projectTicketProvenanceHeader(
  value: unknown,
): TicketProvenanceHeader | undefined {
  if (!isRecord(value)) return undefined;
  const ticket = value.ticket === null ? null : positiveInteger(value.ticket);
  if (ticket === undefined) return undefined;
  if (typeof value.repo !== "string") return undefined;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return undefined;
  }
  // Malformed sessions stay unusable — do not wash into lawful empty (失败诚实).
  const sessions = projectTicketProvenanceSessions(value.sessions);
  if (sessions === undefined) return undefined;
  return {
    repo: value.repo,
    ticket,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    sessions,
  };
}
