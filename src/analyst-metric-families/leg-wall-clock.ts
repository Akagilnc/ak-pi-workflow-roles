/**
 * B1 leg wall-clock metric family (#325).
 *
 * Consumes A2 typed per-run frame spans only — no second ledger scan.
 * Emits: per-leg wallMs, ranking by wall clock desc, median, total elapsed.
 * Registers by file drop under analyst-metric-families/ (A2 discovery).
 */
import { medianNumber } from "../analyst-median.ts";
import type { AnalystReadableRunFacts } from "../analyst-ledger.ts";
import type { AnalystMetricFamilyModule } from "../analyst-metric-family.ts";

/** One readable leg's session-frame wall clock (first usable → last usable). */
export type AnalystLegWallClockEntry = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly wallMs: number;
};

/**
 * Issue-page section: 腿墙钟 + 按墙钟降序腿总榜 + 中位数 + 完全耗时.
 * Only readable in-scope runs (damaged already excluded by A1 scan).
 */
export type AnalystLegWallClockSection = {
  readonly kind: "analyst-leg-wall-clock";
  /** 腿总榜 — each row carries 腿墙钟; ordered by wallMs descending. */
  readonly ranking: readonly AnalystLegWallClockEntry[];
  /** 腿墙钟中位数 — even samples use shared mean-of-two-middles primitive. */
  readonly medianWallMs: number;
  /** 完全耗时 — Σ wallMs of every readable run on the board. */
  readonly totalElapsedMs: number;
};

function frameSpanWallMs(span: {
  readonly startedAt: string;
  readonly endedAt: string;
}): number {
  return Date.parse(span.endedAt) - Date.parse(span.startedAt);
}

function projectEntry(facts: AnalystReadableRunFacts): AnalystLegWallClockEntry {
  return {
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
    wallMs: frameSpanWallMs(facts.frameSpan),
  };
}

function compareRankingDesc(
  a: AnalystLegWallClockEntry,
  b: AnalystLegWallClockEntry,
): number {
  if (b.wallMs !== a.wallMs) return b.wallMs - a.wallMs;
  if (a.book !== b.book) return a.book.localeCompare(b.book);
  if (a.role !== b.role) return a.role.localeCompare(b.role);
  return a.runId.localeCompare(b.runId);
}

/** Discovered by analyst-metric-families loader (default export). */
const legWallClockFamily: AnalystMetricFamilyModule = {
  id: "leg-wall-clock",
  contribute(input) {
    if (input.runs.length === 0) {
      // No readable runs — omit section rather than invent zero metrics.
      return undefined;
    }

    const ranking = input.runs.map(projectEntry).sort(compareRankingDesc);
    const walls = ranking.map((leg) => leg.wallMs);
    const medianWallMs = medianNumber(walls);
    // runs.length > 0 ⇒ medianNumber returns a defined number.
    if (medianWallMs === undefined) {
      return undefined;
    }

    let totalElapsedMs = 0;
    for (const wallMs of walls) totalElapsedMs += wallMs;

    const section: AnalystLegWallClockSection = {
      kind: "analyst-leg-wall-clock",
      ranking,
      medianWallMs,
      totalElapsedMs,
    };
    return { legWallClock: section };
  },
};

export default legWallClockFamily;
