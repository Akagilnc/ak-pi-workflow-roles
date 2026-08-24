/**
 * B4 round-timeline metric family (#328).
 *
 * per-lane (book) run sequence sorted by start time: role, wall clock,
 * receipt status or death channel, judge classCount when present.
 * Unreadable runs appear as placeholder rows sorted by A2 firstFrameAt when
 * present; only when that fact is absent do they annotate absent and sort last.
 *
 * Consumes only A2 typed run facts + unreadable entries — no second scan.
 */
import type { AnalystReadableRunFacts } from "../analyst-ledger.ts";
import type { AnalystMetricFamilyModule } from "../analyst-metric-family.ts";
import type {
  AnalystFirstFrameAt,
  AnalystMissingSource,
  AnalystUnreadableRun,
} from "../analyst-page.ts";

export type AnalystRoundTimelineTerminal =
  | {
      readonly kind: "receipt";
      readonly status: string;
      readonly classCount?: number;
    }
  | {
      readonly kind: "death";
      readonly channel: "no-receipt" | "error" | "audit-incomplete";
    };

export type AnalystRoundTimelineRunRow = {
  readonly kind: "run";
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly wallMs: number;
  readonly terminal: AnalystRoundTimelineTerminal;
};

export type AnalystRoundTimelineUnreadableRow = {
  readonly kind: "unreadable";
  readonly runId: string;
  readonly book: string;
  readonly missingSources: readonly AnalystMissingSource[];
  readonly reason: string;
  /**
   * Projected from A2 unreadable.firstFrameAt. Present → sort by `at`;
   * absent → lane tail.
   */
  readonly firstFrameAt: AnalystFirstFrameAt;
};

export type AnalystRoundTimelineRow =
  | AnalystRoundTimelineRunRow
  | AnalystRoundTimelineUnreadableRow;

export type AnalystRoundTimelineLane = {
  readonly lane: string;
  readonly rows: readonly AnalystRoundTimelineRow[];
};

export type AnalystRoundTimelineSection = {
  readonly kind: "analyst-round-timeline";
  readonly lanes: readonly AnalystRoundTimelineLane[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wallMsFromSpan(startedAt: string, endedAt: string): number {
  return Date.parse(endedAt) - Date.parse(startedAt);
}

function readOutcomeStatus(body: Record<string, unknown>): string | undefined {
  if (!isRecord(body.outcome)) return undefined;
  const status = body.outcome.status;
  if (typeof status !== "string" || status.trim() === "") return undefined;
  return status;
}

function readClassCount(body: Record<string, unknown>): number | undefined {
  if (!isRecord(body.outcome)) return undefined;
  if (!isRecord(body.outcome.decisiveFacts)) return undefined;
  const classCount = body.outcome.decisiveFacts.classCount;
  if (typeof classCount !== "number" || !Number.isFinite(classCount)) {
    return undefined;
  }
  return classCount;
}

function projectTerminal(facts: AnalystReadableRunFacts): AnalystRoundTimelineTerminal {
  if (facts.terminal.status === "absent") {
    return { kind: "death", channel: "no-receipt" };
  }
  if (facts.terminal.file === "error.json") {
    return { kind: "death", channel: "error" };
  }
  if (facts.terminal.file === "audit-incomplete.json") {
    return { kind: "death", channel: "audit-incomplete" };
  }
  // report.json — receipt face; classCount only when producer wrote a number.
  const status = readOutcomeStatus(facts.terminal.body);
  const classCount = readClassCount(facts.terminal.body);
  const receiptStatus = status ?? "unparsed";
  if (classCount === undefined) {
    return { kind: "receipt", status: receiptStatus };
  }
  return { kind: "receipt", status: receiptStatus, classCount };
}

function projectRunRow(facts: AnalystReadableRunFacts): AnalystRoundTimelineRunRow {
  const { startedAt, endedAt } = facts.frameSpan;
  return {
    kind: "run",
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
    startedAt,
    endedAt,
    wallMs: wallMsFromSpan(startedAt, endedAt),
    terminal: projectTerminal(facts),
  };
}

function projectUnreadableRow(
  entry: AnalystUnreadableRun,
): AnalystRoundTimelineUnreadableRow {
  return {
    kind: "unreadable",
    runId: entry.runId,
    book: entry.book,
    missingSources: entry.missingSources,
    reason: entry.reason,
    firstFrameAt: entry.firstFrameAt,
  };
}

/** Sort key: startedAt / present firstFrameAt ascending; absent → +∞ (lane tail). */
function rowSortStartedAt(row: AnalystRoundTimelineRow): string | undefined {
  if (row.kind === "run") return row.startedAt;
  if (row.firstFrameAt.status === "present") return row.firstFrameAt.at;
  return undefined;
}

function compareRows(a: AnalystRoundTimelineRow, b: AnalystRoundTimelineRow): number {
  const aStart = rowSortStartedAt(a);
  const bStart = rowSortStartedAt(b);
  if (aStart === undefined && bStart === undefined) {
    return a.runId.localeCompare(b.runId);
  }
  if (aStart === undefined) return 1;
  if (bStart === undefined) return -1;
  if (aStart !== bStart) return aStart.localeCompare(bStart);
  return a.runId.localeCompare(b.runId);
}

function buildLanes(
  runs: readonly AnalystReadableRunFacts[],
  unreadable: readonly AnalystUnreadableRun[],
): readonly AnalystRoundTimelineLane[] {
  const byLane = new Map<string, AnalystRoundTimelineRow[]>();

  const push = (lane: string, row: AnalystRoundTimelineRow): void => {
    const list = byLane.get(lane);
    if (list === undefined) byLane.set(lane, [row]);
    else list.push(row);
  };

  for (const facts of runs) {
    push(facts.book, projectRunRow(facts));
  }
  for (const entry of unreadable) {
    push(entry.book, projectUnreadableRow(entry));
  }

  return [...byLane.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((lane) => ({
      lane,
      rows: [...(byLane.get(lane) ?? [])].sort(compareRows),
    }));
}

/** Discovered by analyst-metric-families loader (default export). */
const roundTimelineFamily: AnalystMetricFamilyModule = {
  id: "round-timeline",
  contribute(input) {
    if (input.runs.length === 0 && input.unreadable.length === 0) {
      return undefined;
    }
    const section: AnalystRoundTimelineSection = {
      kind: "analyst-round-timeline",
      lanes: buildLanes(input.runs, input.unreadable),
    };
    return { roundTimeline: section };
  },
};

export default roundTimelineFamily;
