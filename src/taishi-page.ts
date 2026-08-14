/**
 * Taishi issue metrics page envelope + atomic persistence (ADR 0068 / PRD #298).
 *
 * A1 minimum fields: issue scope (projectRoot) + leg list + unreadable exclusion.
 * A2: metric-family modules under taishi-metric-families/ contribute optional
 * top-level sections via directory discovery — B/C waves add family files
 * without forking the page writer or editing a shared registry list.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  physicalPathIdentity,
} from "./activation-ledger-topology.ts";
import type { TaishiReadableRunFacts } from "./taishi-ledger.ts";
import { TAISHI_ISSUE_METRIC_FAMILIES } from "./taishi-metric-families.ts";
import { composeTaishiMetricFamilySections } from "./taishi-metric-family.ts";

/** Required run sources that may render a loud unreadable exclusion. */
export type TaishiMissingSource =
  | "session-timeline"
  | "tool-association"
  | "terminal-artifact";

/**
 * First usable session timestamp retained for an unreadable run when the
 * unique session/ledger owner obtained it before the loud failure.
 * Absent only when no usable timestamp was available — not a silent drop.
 */
export type TaishiFirstFrameAt =
  | { readonly status: "present"; readonly at: string }
  | { readonly status: "absent" };

export type TaishiUnreadableRun = {
  readonly runId: string;
  readonly book: string;
  readonly missingSources: readonly TaishiMissingSource[];
  readonly reason: string;
  /** Partial typed fact from A2 seam — B-wave projections sort/annotate from this. */
  readonly firstFrameAt: TaishiFirstFrameAt;
};

/** One readable in-scope leg (A1 identity only; metric families enrich via sections). */
export type TaishiLegEntry = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
};

/**
 * Typed 空缺 for optional numeric metrics (LOC / 耗时每千行).
 * Discriminated — never encode absence as 0 or Infinity.
 */
export type TaishiOptionalMetricNumber =
  | { readonly status: "present"; readonly value: number }
  | { readonly status: "absent" };

/**
 * Optional timestamp face (same shape as firstFrameAt).
 * Used for 末次活动时间戳 when no readable end-frame exists.
 */
export type TaishiOptionalTimestamp =
  | { readonly status: "present"; readonly at: string }
  | { readonly status: "absent" };

/**
 * Per-issue typed metrics page.
 * Extension seam: metric-family modules add optional top-level sections
 * through directory discovery — keep this envelope stable.
 * C1 efficiency fields (完全耗时 / 排除后改动行数 / 耗时每千行 / 末次活动)
 * live on the envelope so sweep can project index rows without family dig.
 */
export type TaishiIssueMetricsPage = {
  readonly kind: "taishi-issue-metrics";
  readonly mode: "issue";
  readonly projectRoot: string;
  readonly legs: readonly TaishiLegEntry[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  readonly unreadableCount: number;
  /** 完全耗时 — Σ readable leg wall clocks (0 when no readable runs). */
  readonly totalElapsedMs: number;
  /** 排除后改动行数 — caller typed input retained; absent when omitted or ≤0. */
  readonly changedLines: TaishiOptionalMetricNumber;
  /** 耗时/千行 — typed 空缺 when LOC absent/0 (no division, never 0/∞). */
  readonly msPerKLines: TaishiOptionalMetricNumber;
  /** 末次活动时间戳 — max readable run end-frame timestamp. */
  readonly lastActivityAt: TaishiOptionalTimestamp;
};

export function taishiIssuePageKey(projectRoot: string): string {
  const identity = physicalPathIdentity(projectRoot);
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

export function taishiIssuePagePath(ledgerHome: string, projectRoot: string): string {
  return join(ledgerHome, "taishi", "issues", `${taishiIssuePageKey(projectRoot)}.json`);
}

function sortLegs(legs: readonly TaishiLegEntry[]): TaishiLegEntry[] {
  return [...legs].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.runId.localeCompare(b.runId);
  });
}

function sortUnreadable(
  unreadable: readonly TaishiUnreadableRun[],
): TaishiUnreadableRun[] {
  return [...unreadable].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    return a.runId.localeCompare(b.runId);
  });
}

/** Normalize caller LOC: omit / non-finite / ≤0 → typed 空缺. */
export function normalizeTaishiChangedLines(
  changedLines: number | undefined,
): TaishiOptionalMetricNumber {
  if (
    changedLines === undefined
    || !Number.isFinite(changedLines)
    || changedLines <= 0
  ) {
    return { status: "absent" };
  }
  return { status: "present", value: changedLines };
}

/**
 * 耗时/千行 = totalElapsedMs ÷ (changedLines/1000).
 * LOC absent/0 → typed 空缺 (no division; never emit 0 or ∞ as stand-in).
 */
export function computeTaishiMsPerKLines(
  totalElapsedMs: number,
  changedLines: TaishiOptionalMetricNumber,
): TaishiOptionalMetricNumber {
  if (changedLines.status === "absent") return { status: "absent" };
  return {
    status: "present",
    value: totalElapsedMs / (changedLines.value / 1000),
  };
}

function frameSpanWallMs(span: {
  readonly startedAt: string;
  readonly endedAt: string;
}): number {
  return Date.parse(span.endedAt) - Date.parse(span.startedAt);
}

/** Σ readable wall clocks + max end-frame (C1 efficiency / index projection). */
export function summarizeTaishiRunEfficiency(
  runs: readonly TaishiReadableRunFacts[],
): {
  readonly totalElapsedMs: number;
  readonly lastActivityAt: TaishiOptionalTimestamp;
} {
  let totalElapsedMs = 0;
  let latestEndedAt: string | undefined;
  for (const run of runs) {
    totalElapsedMs += frameSpanWallMs(run.frameSpan);
    const endedAt = run.frameSpan.endedAt;
    if (latestEndedAt === undefined || endedAt > latestEndedAt) {
      latestEndedAt = endedAt;
    }
  }
  const lastActivityAt: TaishiOptionalTimestamp =
    latestEndedAt === undefined
      ? { status: "absent" }
      : { status: "present", at: latestEndedAt };
  return { totalElapsedMs, lastActivityAt };
}

export function buildTaishiIssueMetricsPage(input: {
  readonly projectRoot: string;
  readonly runs: readonly TaishiReadableRunFacts[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  /** 排除后改动行数 — optional caller typed input (issue/sweep). */
  readonly changedLines?: number;
}): TaishiIssueMetricsPage {
  // Sole run→leg projection owner: page envelope maps typed runs to A1 legs.
  const legs = sortLegs(
    input.runs.map((run) => ({
      runId: run.runId,
      book: run.book,
      role: run.role,
    })),
  );
  const unreadable = sortUnreadable(input.unreadable);
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const { totalElapsedMs, lastActivityAt } = summarizeTaishiRunEfficiency(input.runs);
  const changedLines = normalizeTaishiChangedLines(input.changedLines);
  const msPerKLines = computeTaishiMsPerKLines(totalElapsedMs, changedLines);
  const envelope = {
    kind: "taishi-issue-metrics" as const,
    mode: "issue" as const,
    projectRoot,
    legs,
    unreadable,
    unreadableCount: unreadable.length,
    totalElapsedMs,
    changedLines,
    msPerKLines,
    lastActivityAt,
  };
  const sections = composeTaishiMetricFamilySections(TAISHI_ISSUE_METRIC_FAMILIES, {
    projectRoot,
    runs: input.runs,
    unreadable,
  });
  return { ...envelope, ...sections };
}

/**
 * Atomically replace the issue metrics page (idempotent overwrite).
 * Directory creation and file placement go through the ledger home physical
 * containment owner (ADR 0038 / 0048) — never plain recursive mkdir alone.
 */
export async function writeTaishiIssueMetricsPage(
  ledgerHome: string,
  page: TaishiIssueMetricsPage,
): Promise<string> {
  const path = taishiIssuePagePath(ledgerHome, page.projectRoot);
  ensureRealDirectoryTree(ledgerHome, dirname(path));
  assertLedgerFileInsideHome(path, ledgerHome);
  await writeFileAtomically(path, `${JSON.stringify(page, null, 2)}\n`);
  return path;
}
