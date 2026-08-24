/**
 * B2 metric family — two-bucket full partition + single-leg action board.
 *
 * Consumes A2 typed per-run facts only (frame span + tool intervals).
 * Registers by drop-in under analyst-metric-families/ (A2 assembly discovery).
 *
 * Kernel (single frame-bounded interval core):
 * - every closed tool interval is clipped to the leg frame [frameStart, frameEnd]
 * - tool bucket = union duration of clipped intervals (no double-count)
 * - model bucket = wall − tool bucket (mutual exclusion; sum ≡ wall)
 * - actions = each clipped tool interval + every maximal continuous model gap
 *   (frame complement of tool union, including pre-first and post-last tails),
 *   sorted by duration descending
 * - action median via shared medianNumber (even → mean of two middles)
 * - tool observation: toolName + A2 bash first-line command summary (no re-parse)
 */
import type { SessionToolInterval } from "../ledger-session-read.ts";
import { medianNumber } from "../analyst-median.ts";
import type { AnalystReadableRunFacts } from "../analyst-ledger.ts";
import type { AnalystMetricFamilyModule } from "../analyst-metric-family.ts";

export type AnalystB2ToolAction = {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  /** A2 bash first-line command summary when present. */
  readonly commandSummary?: string;
};

export type AnalystB2ModelAction = {
  readonly kind: "model";
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
};

export type AnalystB2Action = AnalystB2ToolAction | AnalystB2ModelAction;

export type AnalystB2RunMetrics = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly wallMs: number;
  readonly toolBucketMs: number;
  readonly modelBucketMs: number;
  readonly actions: readonly AnalystB2Action[];
  readonly actionDurationMedianMs: number | undefined;
};

export type AnalystB2FrameBucketsActionsSection = {
  readonly kind: "analyst-b2-frame-buckets-actions";
  readonly runs: readonly AnalystB2RunMetrics[];
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

/**
 * Clip closed tools to the leg frame. Empty after clip are dropped.
 * Bucket, complement, and tool actions all consume this same bounded set.
 */
function clipToolsToFrame(
  tools: readonly ClosedTool[],
  frameStartMs: number,
  frameEndMs: number,
): ClosedTool[] {
  if (frameEndMs <= frameStartMs) return [];
  const out: ClosedTool[] = [];
  for (const tool of tools) {
    const startMs = Math.max(tool.startMs, frameStartMs);
    const endMs = Math.min(tool.endMs, frameEndMs);
    if (endMs <= startMs) continue;
    out.push({
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      startMs,
      endMs,
      startedAt: startMs === tool.startMs ? tool.startedAt : toIso(startMs),
      endedAt: endMs === tool.endMs ? tool.endedAt : toIso(endMs),
      ...(tool.command !== undefined ? { command: tool.command } : {}),
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

/**
 * Maximal continuous complement of (already frame-clipped) tool union
 * inside [frameStart, frameEnd]. Includes leading and trailing gaps.
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
    // Union is produced from frame-clipped tools, so bounds already lie in frame.
    if (interval.startMs > cursor) {
      gaps.push({ startMs: cursor, endMs: interval.startMs });
    }
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < frameEndMs) {
    gaps.push({ startMs: cursor, endMs: frameEndMs });
  }
  return gaps;
}

function toolAction(tool: ClosedTool): AnalystB2ToolAction {
  const action: AnalystB2ToolAction = {
    kind: "tool",
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    durationMs: tool.endMs - tool.startMs,
    startedAt: tool.startedAt,
    endedAt: tool.endedAt,
  };
  // A2 already owns bash first-line summary; B2 only projects it.
  if (tool.toolName === "bash" && tool.command !== undefined) {
    return {
      ...action,
      commandSummary: tool.command,
    };
  }
  return action;
}

function modelAction(gap: { startMs: number; endMs: number }): AnalystB2ModelAction {
  return {
    kind: "model",
    durationMs: gap.endMs - gap.startMs,
    startedAt: toIso(gap.startMs),
    endedAt: toIso(gap.endMs),
  };
}

function sortActionsDescending(actions: readonly AnalystB2Action[]): AnalystB2Action[] {
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
export function computeAnalystB2RunMetrics(
  facts: AnalystReadableRunFacts,
): AnalystB2RunMetrics {
  const frameStartMs = timestampMs(facts.frameSpan.startedAt);
  const frameEndMs = timestampMs(facts.frameSpan.endedAt);
  const wallMs = Math.max(0, frameEndMs - frameStartMs);

  // Single frame-bounded core: clip → union once → bucket/complement/actions.
  const tools = clipToolsToFrame(closedTools(facts.toolIntervals), frameStartMs, frameEndMs);
  const toolUnion = mergeUnion(tools);
  const toolBucketMs = toolUnion.reduce(
    (sum, interval) => sum + (interval.endMs - interval.startMs),
    0,
  );
  // Mutual exclusion: model is exact complement duration (no independent recount).
  const modelBucketMs = wallMs - toolBucketMs;

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

const b2FrameBucketsActionsFamily: AnalystMetricFamilyModule = {
  id: "b2-frame-buckets-actions",
  contribute(input) {
    if (input.runs.length === 0) return undefined;
    const runs = [...input.runs]
      .map(computeAnalystB2RunMetrics)
      .sort((a, b) => {
        if (a.book !== b.book) return a.book.localeCompare(b.book);
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        return a.runId.localeCompare(b.runId);
      });
    const section: AnalystB2FrameBucketsActionsSection = {
      kind: "analyst-b2-frame-buckets-actions",
      runs,
    };
    return { b2FrameBucketsActions: section };
  },
};

export default b2FrameBucketsActionsFamily;
