/**
 * B4 round-timeline metric family (#328).
 *
 * per-lane (book) run sequence sorted by start time: role, wall clock,
 * receipt status or death channel, judge classCount when present.
 * Unreadable runs appear as placeholder rows; without a first-frame fact
 * from the A2 seam they sort last and are annotated absent.
 *
 * Consumes only A2 typed run facts + unreadable entries — no second scan,
 * no edits to entry/ledger/page skeleton.
 */
import type { TaishiReadableRunFacts } from "../taishi-ledger.ts";
import type { TaishiMetricFamilyModule } from "../taishi-metric-family.ts";
import type { TaishiMissingSource, TaishiUnreadableRun } from "../taishi-page.ts";

export type TaishiRoundTimelineTerminal =
  | {
      readonly kind: "receipt";
      readonly status: string;
      readonly classCount?: number;
    }
  | {
      readonly kind: "death";
      readonly channel: "no-receipt" | "error" | "audit-incomplete";
    };

export type TaishiRoundTimelineRunRow = {
  readonly kind: "run";
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly wallMs: number;
  readonly terminal: TaishiRoundTimelineTerminal;
};

export type TaishiRoundTimelineUnreadableRow = {
  readonly kind: "unreadable";
  readonly runId: string;
  readonly book: string;
  readonly missingSources: readonly TaishiMissingSource[];
  readonly reason: string;
  /**
   * A2 unreadable entries do not retain a first-frame timestamp, so the
   * sort oracle places them at the end of their lane and records absence.
   */
  readonly firstFrameAt: { readonly status: "absent" };
};

export type TaishiRoundTimelineRow =
  | TaishiRoundTimelineRunRow
  | TaishiRoundTimelineUnreadableRow;

export type TaishiRoundTimelineLane = {
  readonly lane: string;
  readonly rows: readonly TaishiRoundTimelineRow[];
};

export type TaishiRoundTimelineSection = {
  readonly kind: "taishi-round-timeline";
  readonly lanes: readonly TaishiRoundTimelineLane[];
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

function projectTerminal(facts: TaishiReadableRunFacts): TaishiRoundTimelineTerminal {
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

function projectRunRow(facts: TaishiReadableRunFacts): TaishiRoundTimelineRunRow {
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
  entry: TaishiUnreadableRun,
): TaishiRoundTimelineUnreadableRow {
  return {
    kind: "unreadable",
    runId: entry.runId,
    book: entry.book,
    missingSources: entry.missingSources,
    reason: entry.reason,
    firstFrameAt: { status: "absent" },
  };
}

/** Sort key: startedAt ascending; absent first-frame → +∞ (lane tail). */
function rowSortStartedAt(row: TaishiRoundTimelineRow): string | undefined {
  if (row.kind === "run") return row.startedAt;
  return undefined;
}

function compareRows(a: TaishiRoundTimelineRow, b: TaishiRoundTimelineRow): number {
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
  runs: readonly TaishiReadableRunFacts[],
  unreadable: readonly TaishiUnreadableRun[],
): readonly TaishiRoundTimelineLane[] {
  const byLane = new Map<string, TaishiRoundTimelineRow[]>();

  const push = (lane: string, row: TaishiRoundTimelineRow): void => {
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

/** Discovered by taishi-metric-families loader (default export). */
const roundTimelineFamily: TaishiMetricFamilyModule = {
  id: "round-timeline",
  contribute(input) {
    if (input.runs.length === 0 && input.unreadable.length === 0) {
      return undefined;
    }
    const section: TaishiRoundTimelineSection = {
      kind: "taishi-round-timeline",
      lanes: buildLanes(input.runs, input.unreadable),
    };
    return { roundTimeline: section };
  },
};

export default roundTimelineFamily;
