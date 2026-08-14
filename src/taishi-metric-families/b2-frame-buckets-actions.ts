/**
 * B2 metric family — two-bucket full partition + single-leg action board.
 *
 * Consumes A2 typed per-run facts only (frame span + tool intervals).
 * Registers by drop-in under taishi-metric-families/ (A2 assembly discovery).
 *
 * Kernel:
 * - tool bucket = union duration of closed toolCallId intervals (no double-count)
 * - model bucket = wall − tool bucket (mutual exclusion; sum ≡ wall)
 * - actions = each closed tool interval + every maximal continuous model gap
 *   (frame complement of tool union, including pre-first and post-last tails),
 *   sorted by duration descending
 * - action median via shared medianNumber (even → mean of two middles)
 * - tool observation: toolName + bash first-line command summary
 */
import type { SessionToolInterval } from "../ledger-session-read.ts";
import { medianNumber } from "../taishi-median.ts";
import type { TaishiReadableRunFacts } from "../taishi-ledger.ts";
import type { TaishiMetricFamilyModule } from "../taishi-metric-family.ts";

export type TaishiB2ToolAction = {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  /** First line of bash `command` argument when present. */
  readonly commandSummary?: string;
};

export type TaishiB2ModelAction = {
  readonly kind: "model";
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
};

export type TaishiB2Action = TaishiB2ToolAction | TaishiB2ModelAction;

export type TaishiB2RunMetrics = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly wallMs: number;
  readonly toolBucketMs: number;
  readonly modelBucketMs: number;
  readonly actions: readonly TaishiB2Action[];
  readonly actionDurationMedianMs: number | undefined;
};

export type TaishiB2FrameBucketsActionsSection = {
  readonly kind: "taishi-b2-frame-buckets-actions";
  readonly runs: readonly TaishiB2RunMetrics[];
};

type ClosedTool = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly command?: string;
};

function timestampMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`unparseable timestamp: ${iso}`);
  }
  return ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** First line of a command body (bash observation field). */
export function bashCommandFirstLine(command: string): string {
  const match = /^[^\r\n]*/.exec(command);
  return match?.[0] ?? "";
}

function closedTools(intervals: readonly SessionToolInterval[]): ClosedTool[] {
  const out: ClosedTool[] = [];
  for (const interval of intervals) {
    if (interval.endedAt === undefined) continue;
    const startMs = timestampMs(interval.startedAt);
    const endMs = timestampMs(interval.endedAt);
    if (endMs <= startMs) continue;
    out.push({
      toolCallId: interval.toolCallId,
      toolName: interval.toolName,
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      startMs,
      endMs,
      ...(interval.command !== undefined ? { command: interval.command } : {}),
    });
  }
  return out;
}

/** Merge overlapping/adjacent [start,end) intervals; return sorted disjoint union. */
function mergeUnion(intervals: readonly { startMs: number; endMs: number }[]): {
  startMs: number;
  endMs: number;
}[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const merged: { startMs: number; endMs: number }[] = [
    { startMs: sorted[0]!.startMs, endMs: sorted[0]!.endMs },
  ];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cur.endMs);
    } else {
      merged.push({ startMs: cur.startMs, endMs: cur.endMs });
    }
  }
  return merged;
}

function unionDurationMs(
  intervals: readonly { startMs: number; endMs: number }[],
): number {
  return mergeUnion(intervals).reduce(
    (sum, interval) => sum + (interval.endMs - interval.startMs),
    0,
  );
}

/**
 * Maximal continuous complement of tool union inside [frameStart, frameEnd].
 * Includes leading gap before first tool and trailing gap after last tool.
 */
function modelMaximalIntervals(
  frameStartMs: number,
  frameEndMs: number,
  toolUnion: readonly { startMs: number; endMs: number }[],
): { startMs: number; endMs: number }[] {
  if (frameEndMs <= frameStartMs) return [];
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = frameStartMs;
  for (const interval of toolUnion) {
    const start = Math.max(interval.startMs, frameStartMs);
    const end = Math.min(interval.endMs, frameEndMs);
    if (end <= start) continue;
    if (start > cursor) {
      gaps.push({ startMs: cursor, endMs: start });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < frameEndMs) {
    gaps.push({ startMs: cursor, endMs: frameEndMs });
  }
  return gaps.filter((gap) => gap.endMs > gap.startMs);
}

function toolAction(tool: ClosedTool): TaishiB2ToolAction {
  const action: TaishiB2ToolAction = {
    kind: "tool",
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    durationMs: tool.endMs - tool.startMs,
    startedAt: tool.startedAt,
    endedAt: tool.endedAt,
  };
  if (tool.toolName === "bash" && tool.command !== undefined) {
    return {
      ...action,
      commandSummary: bashCommandFirstLine(tool.command),
    };
  }
  return action;
}

function modelAction(gap: { startMs: number; endMs: number }): TaishiB2ModelAction {
  return {
    kind: "model",
    durationMs: gap.endMs - gap.startMs,
    startedAt: toIso(gap.startMs),
    endedAt: toIso(gap.endMs),
  };
}

function sortActionsDescending(actions: readonly TaishiB2Action[]): TaishiB2Action[] {
  return [...actions].sort((a, b) => {
    if (b.durationMs !== a.durationMs) return b.durationMs - a.durationMs;
    // Stable tie-break: earlier start first, then kind/toolCallId for determinism.
    if (a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.kind === "tool" && b.kind === "tool") {
      return a.toolCallId.localeCompare(b.toolCallId);
    }
    return 0;
  });
}

/** Pure B2 kernel over one readable run's A2 facts. */
export function computeTaishiB2RunMetrics(
  facts: TaishiReadableRunFacts,
): TaishiB2RunMetrics {
  const frameStartMs = timestampMs(facts.frameSpan.startedAt);
  const frameEndMs = timestampMs(facts.frameSpan.endedAt);
  const wallMs = Math.max(0, frameEndMs - frameStartMs);

  const tools = closedTools(facts.toolIntervals);
  const toolUnion = mergeUnion(tools);
  const toolBucketMs = unionDurationMs(toolUnion);
  // Mutual exclusion: model is exact complement duration (no independent recount).
  const modelBucketMs = Math.max(0, wallMs - toolBucketMs);

  const modelGaps = modelMaximalIntervals(frameStartMs, frameEndMs, toolUnion);
  const actions = sortActionsDescending([
    ...tools.map(toolAction),
    ...modelGaps.map(modelAction),
  ]);
  const actionDurationMedianMs = medianNumber(actions.map((action) => action.durationMs));

  return {
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
    wallMs,
    toolBucketMs,
    modelBucketMs,
    actions,
    actionDurationMedianMs,
  };
}

const b2FrameBucketsActionsFamily: TaishiMetricFamilyModule = {
  id: "b2-frame-buckets-actions",
  contribute(input) {
    if (input.runs.length === 0) return undefined;
    const runs = [...input.runs]
      .map(computeTaishiB2RunMetrics)
      .sort((a, b) => {
        if (a.book !== b.book) return a.book.localeCompare(b.book);
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        return a.runId.localeCompare(b.runId);
      });
    const section: TaishiB2FrameBucketsActionsSection = {
      kind: "taishi-b2-frame-buckets-actions",
      runs,
    };
    return { b2FrameBucketsActions: section };
  },
};

export default b2FrameBucketsActionsFamily;
