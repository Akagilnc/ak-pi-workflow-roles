/**
 * Analyst issue metrics page envelope + atomic persistence (ADR 0068 / PRD #298).
 *
 * A1 minimum fields: issue scope (projectRoot) + leg list + unreadable exclusion.
 * A2: metric-family modules under analyst-metric-families/ contribute optional
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
import type { AnalystReadableRunFacts } from "./analyst-ledger.ts";
import { loadAnalystIssueMetricFamilies } from "./analyst-metric-families.ts";
import { composeAnalystMetricFamilySections } from "./analyst-metric-family.ts";

/** Required run sources that may render a loud unreadable exclusion. */
export type AnalystMissingSource =
  | "session-timeline"
  | "tool-association"
  | "terminal-artifact"
  /** Model-groups mode: leg has no usable session model identity. */
  | "session-model";

/**
 * First usable session timestamp retained for an unreadable run when the
 * unique session/ledger owner obtained it before the loud failure.
 * Absent only when no usable timestamp was available — not a silent drop.
 */
export type AnalystFirstFrameAt =
  | { readonly status: "present"; readonly at: string }
  | { readonly status: "absent" };

export type AnalystUnreadableRun = {
  readonly runId: string;
  readonly book: string;
  readonly missingSources: readonly AnalystMissingSource[];
  readonly reason: string;
  /** Partial typed fact from A2 seam — B-wave projections sort/annotate from this. */
  readonly firstFrameAt: AnalystFirstFrameAt;
  /**
   * Available session end-frame when classify obtained one before loud failure.
   * Feeds lastActivityAt (PRD ②: max end-frame across ALL runs); still excluded
   * from totalElapsedMs / ranking stats.
   */
  readonly lastFrameAt: AnalystOptionalTimestamp;
};

/** One readable in-scope leg (A1 identity only; metric families enrich via sections). */
export type AnalystLegEntry = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
};

/**
 * C4 scope conflict fact (typed ticketNumber over projectRoot).
 * - Ledger-run path: run admitted by typed ticket while its invocation
 *   projectRoot differed — records runId + ticketNumber + run projectRoot + fact.
 * - Caller dual-param path: ticket/index root won over a concurrent caller
 *   projectRoot — records ticketNumber + losing projectRoot + fact (no runId;
 *   the conflict is the call faces themselves, not a ledger alien run).
 */
export type AnalystScopeConflict = {
  /** Present only for ledger-run conflicts; omitted for caller dual-param. */
  readonly runId?: string;
  readonly ticketNumber: number;
  readonly projectRoot: string;
  readonly fact: "typed-ticketNumber-over-projectRoot";
};

/**
 * Typed 空缺 for optional numeric metrics (LOC / 耗时每千行).
 * Discriminated — never encode absence as 0 or Infinity.
 */
export type AnalystOptionalMetricNumber =
  | { readonly status: "present"; readonly value: number }
  | { readonly status: "absent" };

/**
 * Optional timestamp face (same shape as firstFrameAt).
 * Used for 末次活动时间戳 when no available end-frame exists.
 */
export type AnalystOptionalTimestamp =
  | { readonly status: "present"; readonly at: string }
  | { readonly status: "absent" };

/**
 * Per-issue typed metrics page.
 * Extension seam: metric-family modules add optional top-level sections
 * through directory discovery — keep this envelope stable.
 * C1 efficiency fields (完全耗时 / 排除后改动行数 / 耗时每千行 / 末次活动)
 * live on the envelope so sweep can project index rows without family dig.
 * #399: page mechanical address includes book identity (and ticket when set).
 * projectRoot is a retained recording/display field — not the address key.
 */
export type AnalystIssueMetricsPage = {
  readonly kind: "analyst-issue-metrics";
  readonly mode: "issue";
  /** Ledger book identity — part of the page mechanical address (#399). */
  readonly bookKey: string;
  /**
   * Recording/display face (cwd or sweep workspace pointer).
   * Not the page mechanical key after #399 / ADR 0068 revision.
   */
  readonly projectRoot: string;
  /** Caller typed issue number — present only when supplied on the entry. */
  readonly issueNumber?: number;
  /**
   * Path-narrow address fragment for sweep/legacy fixture pages that share a
   * book but represent distinct workspace roots. Absent on CLI book/ticket pages.
   */
  readonly scopeRootIdentity?: string;
  readonly legs: readonly AnalystLegEntry[];
  readonly unreadable: readonly AnalystUnreadableRun[];
  readonly unreadableCount: number;
  /**
   * C4: typed-ticketNumber-over-projectRoot facts — ledger-run admits whose
   * invocation projectRoot differed, and/or caller dual-param conflicts where
   * ticket/index root won over a concurrent projectRoot face.
   */
  readonly scopeConflicts: readonly AnalystScopeConflict[];
  /** 完全耗时 — Σ readable leg wall clocks (0 when no readable runs). */
  readonly totalElapsedMs: number;
  /** 排除后改动行数 — caller typed input retained; absent when omitted or 0. */
  readonly changedLines: AnalystOptionalMetricNumber;
  /** 耗时/千行 — typed 空缺 when LOC absent/0 (no division, never 0/∞). */
  readonly msPerKLines: AnalystOptionalMetricNumber;
  /** 末次活动时间戳 — max end-frame across ALL runs (incl. unreadable available). */
  readonly lastActivityAt: AnalystOptionalTimestamp;
};

/**
 * Page mechanical address (#399): always carries book identity.
 * - book scope (CLI bare): bookKey only
 * - ticket scope (CLI --ticket N): bookKey + issueNumber
 * - root-narrow (sweep/legacy): bookKey + scopeRootIdentity
 */
export type AnalystIssuePageAddress = {
  readonly bookKey: string;
  readonly issueNumber?: number;
  readonly scopeRootIdentity?: string;
};

export function analystIssuePageKey(address: AnalystIssuePageAddress): string {
  const parts = ["book", address.bookKey];
  if (address.issueNumber !== undefined) {
    parts.push("ticket", String(address.issueNumber));
  } else if (address.scopeRootIdentity !== undefined) {
    parts.push("root", physicalPathIdentity(address.scopeRootIdentity));
  }
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

export function analystIssuePagePath(
  ledgerHome: string,
  address: AnalystIssuePageAddress,
): string {
  return join(ledgerHome, "analyst", "issues", `${analystIssuePageKey(address)}.json`);
}

export function analystIssuePageAddressFromPage(
  page: Pick<
    AnalystIssueMetricsPage,
    "bookKey" | "issueNumber" | "scopeRootIdentity"
  >,
): AnalystIssuePageAddress {
  return {
    bookKey: page.bookKey,
    ...(page.issueNumber === undefined ? {} : { issueNumber: page.issueNumber }),
    ...(page.scopeRootIdentity === undefined
      ? {}
      : { scopeRootIdentity: page.scopeRootIdentity }),
  };
}

function sortLegs(legs: readonly AnalystLegEntry[]): AnalystLegEntry[] {
  return [...legs].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.runId.localeCompare(b.runId);
  });
}

function sortUnreadable(
  unreadable: readonly AnalystUnreadableRun[],
): AnalystUnreadableRun[] {
  return [...unreadable].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    return a.runId.localeCompare(b.runId);
  });
}

function sortScopeConflicts(
  conflicts: readonly AnalystScopeConflict[],
): AnalystScopeConflict[] {
  return [...conflicts].sort((a, b) => {
    // Caller dual-param (no runId) sorts before run conflicts; then by root.
    const aRun = a.runId ?? "";
    const bRun = b.runId ?? "";
    if (aRun !== bRun) return aRun.localeCompare(bRun);
    return a.projectRoot.localeCompare(b.projectRoot);
  });
}

/**
 * Admit caller LOC at the typed input boundary.
 * Finite non-negative only; 0 remains a lawful typed 空缺 signal (not rejected).
 * NaN / negative / ±Infinity are structural rejects (sweep attach + issue mode).
 */
export function assertAnalystChangedLinesInput(
  changedLines: number | undefined,
): void {
  if (changedLines === undefined) return;
  if (typeof changedLines !== "number" || !Number.isFinite(changedLines) || changedLines < 0) {
    throw new Error(
      `analyst changedLines must be a finite non-negative number, got ${String(changedLines)}`,
    );
  }
}

/**
 * Normalize caller LOC: only omit or 0 → typed 空缺 (PRD efficiency口径).
 * Callers must pass {@link assertAnalystChangedLinesInput} first.
 */
export function normalizeAnalystChangedLines(
  changedLines: number | undefined,
): AnalystOptionalMetricNumber {
  assertAnalystChangedLinesInput(changedLines);
  if (changedLines === undefined || changedLines === 0) {
    return { status: "absent" };
  }
  return { status: "present", value: changedLines };
}

/**
 * 耗时/千行 = totalElapsedMs ÷ (changedLines/1000).
 * LOC absent/0 → typed 空缺 (no division; never emit 0 or ∞ as stand-in).
 */
export function computeAnalystMsPerKLines(
  totalElapsedMs: number,
  changedLines: AnalystOptionalMetricNumber,
): AnalystOptionalMetricNumber {
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

/**
 * Σ readable wall clocks + max end-frame across ALL runs (C1 efficiency / index).
 * Unreadable runs never enter totalElapsedMs; their available lastFrameAt still
 * competes for lastActivityAt (PRD ②: 全部 run 末帧之最大者).
 */
export function summarizeAnalystRunEfficiency(
  runs: readonly AnalystReadableRunFacts[],
  unreadable: readonly AnalystUnreadableRun[] = [],
): {
  readonly totalElapsedMs: number;
  readonly lastActivityAt: AnalystOptionalTimestamp;
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
  for (const entry of unreadable) {
    if (entry.lastFrameAt.status !== "present") continue;
    const endedAt = entry.lastFrameAt.at;
    if (latestEndedAt === undefined || endedAt > latestEndedAt) {
      latestEndedAt = endedAt;
    }
  }
  const lastActivityAt: AnalystOptionalTimestamp =
    latestEndedAt === undefined
      ? { status: "absent" }
      : { status: "present", at: latestEndedAt };
  return { totalElapsedMs, lastActivityAt };
}

export async function buildAnalystIssueMetricsPage(input: {
  readonly bookKey: string;
  readonly projectRoot: string;
  readonly runs: readonly AnalystReadableRunFacts[];
  readonly unreadable: readonly AnalystUnreadableRun[];
  /** C4: scope conflicts observed while admitting runs (default none). */
  readonly scopeConflicts?: readonly AnalystScopeConflict[];
  /** 排除后改动行数 — optional caller typed input (issue/sweep). */
  readonly changedLines?: number;
  /** Caller typed issue number — retained on page for cohort index join. */
  readonly issueNumber?: number;
  /**
   * When set, page address is book+root (sweep/legacy path-narrow).
   * Must be absent for CLI whole-book / ticket pages so cross-cwd same book collides correctly.
   */
  readonly scopeRootIdentity?: string;
}): Promise<AnalystIssueMetricsPage> {
  // Discover before compose/write — missing family tree fails loud with native
  // ENOENT/ENOTDIR (no empty-registry wash) and never emits a success page.
  const families = await loadAnalystIssueMetricFamilies();
  // Sole run→leg projection owner: page envelope maps typed runs to A1 legs.
  const legs = sortLegs(
    input.runs.map((run) => ({
      runId: run.runId,
      book: run.book,
      role: run.role,
    })),
  );
  const unreadable = sortUnreadable(input.unreadable);
  const scopeConflicts = sortScopeConflicts(input.scopeConflicts ?? []);
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const { totalElapsedMs, lastActivityAt } = summarizeAnalystRunEfficiency(
    input.runs,
    unreadable,
  );
  const changedLines = normalizeAnalystChangedLines(input.changedLines);
  const msPerKLines = computeAnalystMsPerKLines(totalElapsedMs, changedLines);
  const envelope = {
    kind: "analyst-issue-metrics" as const,
    mode: "issue" as const,
    bookKey: input.bookKey,
    projectRoot,
    // exactOptionalPropertyTypes: only materialize when caller supplied it.
    ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
    ...(input.scopeRootIdentity === undefined
      ? {}
      : { scopeRootIdentity: physicalPathIdentity(input.scopeRootIdentity) }),
    legs,
    unreadable,
    unreadableCount: unreadable.length,
    scopeConflicts,
    totalElapsedMs,
    changedLines,
    msPerKLines,
    lastActivityAt,
  };
  const sections = composeAnalystMetricFamilySections(families, {
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
export async function writeAnalystIssueMetricsPage(
  ledgerHome: string,
  page: AnalystIssueMetricsPage,
): Promise<string> {
  const path = analystIssuePagePath(ledgerHome, analystIssuePageAddressFromPage(page));
  ensureRealDirectoryTree(ledgerHome, dirname(path));
  assertLedgerFileInsideHome(path, ledgerHome);
  await writeFileAtomically(path, `${JSON.stringify(page, null, 2)}\n`);
  return path;
}
