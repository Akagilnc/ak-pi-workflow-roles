/**
 * Taishi library index page (ADR 0068 / PRD #298 output ②).
 *
 * Sweep mode maintains one self-sufficient row per issue:
 * 完全耗时 / 排除后改动行数 / 耗时每千行 / 末次活动时间戳.
 * Rows carry their own sort keys — readers choose order (Story 6/8).
 *
 * Cross-book one row per issue. C2 joins cohort groups by issueNumber →
 * projectRoot page reference (ADR 0068 mechanical key). Missing row =
 * typed vacancy entry — never silent skip, never live recompute.
 */
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
} from "./activation-ledger-topology.ts";
import type {
  TaishiIssueMetricsPage,
  TaishiOptionalMetricNumber,
  TaishiOptionalTimestamp,
} from "./taishi-page.ts";

/**
 * One issue row on the cross-book library index.
 * projectRoot = page addressing key (ADR 0068).
 * issueNumber = optional caller typed field retained for cohort join.
 * C1 four columns make the row self-sufficient for cross-issue listing.
 */
export type TaishiLibraryIndexRow = {
  readonly projectRoot: string;
  /** Caller typed issue number — present when issue-mode supplied it for cohort join. */
  readonly issueNumber?: number;
  /** 完全耗时 — Σ readable leg wall clocks. */
  readonly totalElapsedMs: number;
  /** 排除后改动行数 — caller typed input; may be typed 空缺. */
  readonly changedLines: TaishiOptionalMetricNumber;
  /** 耗时/千行 — absent when LOC absent/0 (never 0 or ∞ stand-in). */
  readonly msPerKLines: TaishiOptionalMetricNumber;
  /** 末次活动时间戳 — max end-frame across ALL runs (incl. unreadable available). */
  readonly lastActivityAt: TaishiOptionalTimestamp;
};

/**
 * Library index page — unique true source for cross-issue listing / cohort join.
 * No md second projection; render on demand.
 */
export type TaishiLibraryIndexPage = {
  readonly kind: "taishi-library-index";
  readonly rows: readonly TaishiLibraryIndexRow[];
};

export function taishiLibraryIndexPath(ledgerHome: string): string {
  return join(ledgerHome, "taishi", "library-index.json");
}

export function rowFromIssueMetricsPage(
  page: TaishiIssueMetricsPage,
): TaishiLibraryIndexRow {
  return {
    projectRoot: page.projectRoot,
    // exactOptionalPropertyTypes: only materialize when page carries it.
    ...(page.issueNumber === undefined ? {} : { issueNumber: page.issueNumber }),
    totalElapsedMs: page.totalElapsedMs,
    changedLines: page.changedLines,
    msPerKLines: page.msPerKLines,
    lastActivityAt: page.lastActivityAt,
  };
}

function sortRows(
  rows: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexRow[] {
  // Stable projectRoot sort (C1 listing). Cohort join is by issueNumber find,
  // not row order — issueNumber secondary keeps C2 rows deterministic too.
  return [...rows].sort((a, b) => {
    const byRoot = a.projectRoot.localeCompare(b.projectRoot);
    if (byRoot !== 0) return byRoot;
    const aNum = a.issueNumber;
    const bNum = b.issueNumber;
    if (aNum === undefined && bNum === undefined) return 0;
    if (aNum === undefined) return 1;
    if (bNum === undefined) return -1;
    return aNum - bNum;
  });
}

/** Build a fresh index from the given rows (stable projectRoot, then issueNumber). */
export function buildTaishiLibraryIndexPage(
  rows: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexPage {
  return {
    kind: "taishi-library-index",
    rows: sortRows(rows),
  };
}

/**
 * Look up the first index row for an issue number.
 * Absence is a lawful cohort vacancy signal — not an error.
 */
export function findTaishiLibraryIndexRow(
  index: TaishiLibraryIndexPage | undefined,
  issueNumber: number,
): TaishiLibraryIndexRow | undefined {
  if (index === undefined) return undefined;
  return index.rows.find((row) => row.issueNumber === issueNumber);
}

/**
 * Upsert issue rows into an existing index (or empty).
 * - One row per projectRoot — re-sweep overwrites that issue's row only (C1).
 * - When issueNumber is present, also unique per issueNumber — re-issue
 *   overwrites that number's row only (C2 issueNumber→projectRoot join).
 */
export function upsertTaishiLibraryIndexRows(
  existing: TaishiLibraryIndexPage | undefined,
  upserts: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexPage {
  const byRoot = new Map<string, TaishiLibraryIndexRow>();
  const rootByIssue = new Map<number, string>();

  const ingest = (row: TaishiLibraryIndexRow): void => {
    // C2 uniqueness: one row per issueNumber — drop prior root if number moved.
    if (row.issueNumber !== undefined) {
      const priorRoot = rootByIssue.get(row.issueNumber);
      if (priorRoot !== undefined && priorRoot !== row.projectRoot) {
        byRoot.delete(priorRoot);
      }
    }
    // C1 uniqueness: one row per projectRoot — drop prior issue map if root reused.
    const prior = byRoot.get(row.projectRoot);
    if (
      prior !== undefined
      && prior.issueNumber !== undefined
      && prior.issueNumber !== row.issueNumber
    ) {
      rootByIssue.delete(prior.issueNumber);
    }
    byRoot.set(row.projectRoot, row);
    if (row.issueNumber !== undefined) {
      rootByIssue.set(row.issueNumber, row.projectRoot);
    }
  };

  if (existing !== undefined) {
    for (const row of existing.rows) {
      ingest(row);
    }
  }
  for (const row of upserts) {
    ingest(row);
  }
  return buildTaishiLibraryIndexPage([...byRoot.values()]);
}

/**
 * Read existing library index, or undefined when absent.
 * Single typed producer writes this file — JSON.parse failure is loud;
 * no bespoke shape validator on the self-read path.
 */
export async function readTaishiLibraryIndexPage(
  ledgerHome: string,
): Promise<TaishiLibraryIndexPage | undefined> {
  const path = taishiLibraryIndexPath(ledgerHome);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(raw) as TaishiLibraryIndexPage;
}

/**
 * Atomically replace the library index page.
 * Directory creation goes through ledger home physical containment.
 */
export async function writeTaishiLibraryIndexPage(
  ledgerHome: string,
  page: TaishiLibraryIndexPage,
): Promise<string> {
  const path = taishiLibraryIndexPath(ledgerHome);
  ensureRealDirectoryTree(ledgerHome, dirname(path));
  assertLedgerFileInsideHome(path, ledgerHome);
  await writeFileAtomically(path, `${JSON.stringify(page, null, 2)}\n`);
  return path;
}
