/**
 * Taishi library index page (ADR 0068 / PRD #298 output ②).
 *
 * Sweep mode maintains one self-sufficient row per issue:
 * 完全耗时 / 排除后改动行数 / 耗时每千行 / 末次活动时间戳.
 * Rows carry their own sort keys — readers choose order (Story 6/8).
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

/** One issue row on the cross-book library index. */
export type TaishiLibraryIndexRow = {
  readonly projectRoot: string;
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
 * Library index page — unique true source for cross-issue listing.
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
    totalElapsedMs: page.totalElapsedMs,
    changedLines: page.changedLines,
    msPerKLines: page.msPerKLines,
    lastActivityAt: page.lastActivityAt,
  };
}

function sortRows(
  rows: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexRow[] {
  return [...rows].sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

/** Build a fresh index from the given rows (stable projectRoot sort). */
export function buildTaishiLibraryIndexPage(
  rows: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexPage {
  return {
    kind: "taishi-library-index",
    rows: sortRows(rows),
  };
}

/**
 * Upsert swept issue rows into an existing index (or empty).
 * One row per projectRoot — re-sweep overwrites that issue's row only.
 */
export function upsertTaishiLibraryIndexRows(
  existing: TaishiLibraryIndexPage | undefined,
  upserts: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexPage {
  const byRoot = new Map<string, TaishiLibraryIndexRow>();
  if (existing !== undefined) {
    for (const row of existing.rows) {
      byRoot.set(row.projectRoot, row);
    }
  }
  for (const row of upserts) {
    byRoot.set(row.projectRoot, row);
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
