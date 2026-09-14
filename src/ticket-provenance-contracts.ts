/**
 * 起居录（ticket-provenance）typed 形状 —— ADR 0075「2026-09-14 修订」/ #901。
 *
 * 一册＝一个文件：第一行册子头，其后每行一条对话。
 * 每轮按册子头当前各区间**重投影**这份唯一文件：册子头与各条定位可更新，
 * 正文原样不改（`single-volume` / `one-volume-per-issue`）。
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

/** 册子头记的一卷：会话卷路径 + 本轮该卷的各区间。 */
export type TicketProvenanceSession = {
  readonly path: string;
  readonly ranges: readonly TicketProvenanceRange[];
};

/** 册子头（文件第一行）。reopen 与跨宿主为新增区间，不新建册。 */
export type TicketProvenanceHeader = {
  readonly repo: string;
  readonly ticket: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessions: readonly TicketProvenanceSession[];
};

/**
 * 一条对话（册子头之后每行一条）。
 * `id` 与 `line` 按源事实存在则记、不存在不编；两者皆无的少数条目
 * 靠录中前后有定位的条目锚定。
 */
export type TicketProvenanceLine = {
  readonly speaker: TicketProvenanceSpeaker;
  /** 卷下标（册子头 `sessions` 的位置）。 */
  readonly s: number;
  readonly line?: number;
  readonly id?: string;
  readonly text: string;
};

/**
 * 坏行补写：绑定源卷与行，带说话人与正文。
 * 编没编由符宝郎读录核旨，代码不判断（`unparsable-line-to-diarist`）。
 */
export type TicketProvenanceAmendment = {
  readonly s: number;
  readonly line: number;
  readonly speaker: TicketProvenanceSpeaker;
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

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function projectSpeaker(value: unknown): TicketProvenanceSpeaker | undefined {
  return value === "owner" || value === "runner" ? value : undefined;
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

/**
 * 投影补写集合。缺该字段＝无补写（不拒收）；成员形状不成立的整条跳过——
 * 它没有绑定位置，放不回去。
 */
export function projectTicketProvenanceAmendments(
  value: unknown,
): readonly TicketProvenanceAmendment[] {
  if (!Array.isArray(value)) return [];
  const out: TicketProvenanceAmendment[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const s = nonNegativeInteger(raw.s);
    const line = positiveInteger(raw.line);
    const speaker = projectSpeaker(raw.speaker);
    const text = raw.text;
    if (s === undefined || line === undefined || speaker === undefined) continue;
    if (typeof text !== "string") continue;
    out.push({ s, line, speaker, text });
  }
  return out;
}

/** 读回册子头（文件第一行）。形状不成立即 undefined——按无册处理，不猜。 */
export function projectTicketProvenanceHeader(
  value: unknown,
): TicketProvenanceHeader | undefined {
  if (!isRecord(value)) return undefined;
  const ticket = positiveInteger(value.ticket);
  if (ticket === undefined) return undefined;
  if (typeof value.repo !== "string") return undefined;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    return undefined;
  }
  const sessions = projectTicketProvenanceSessions(value.sessions) ?? [];
  return {
    repo: value.repo,
    ticket,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    sessions,
  };
}

/** 读回一条对话行。 */
export function projectTicketProvenanceLine(
  value: unknown,
): TicketProvenanceLine | undefined {
  if (!isRecord(value)) return undefined;
  const speaker = projectSpeaker(value.speaker);
  const s = nonNegativeInteger(value.s);
  if (speaker === undefined || s === undefined) return undefined;
  if (typeof value.text !== "string") return undefined;
  const line = positiveInteger(value.line);
  const id = typeof value.id === "string" && value.id !== "" ? value.id : undefined;
  return {
    speaker,
    s,
    ...(line === undefined ? {} : { line }),
    ...(id === undefined ? {} : { id }),
    text: value.text,
  };
}
