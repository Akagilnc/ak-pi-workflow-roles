/**
 * Taishi library index page (ADR 0068 / PRD #298 output ②).
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

/**
 * One issue row on the cross-book library index.
 * issueNumber = caller typed field retained for cohort join;
 * projectRoot = page addressing key (ADR 0068).
 */
export type TaishiLibraryIndexRow = {
  readonly issueNumber: number;
  readonly projectRoot: string;
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

function sortRows(
  rows: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexRow[] {
  return [...rows].sort((a, b) => {
    if (a.issueNumber !== b.issueNumber) return a.issueNumber - b.issueNumber;
    return a.projectRoot.localeCompare(b.projectRoot);
  });
}

/** Build a fresh index from the given rows (stable issueNumber, then projectRoot). */
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
 * Upsert issueNumber→projectRoot rows into an existing index (or empty).
 * One unique row per issueNumber — re-issue overwrites that issue's row only.
 */
export function upsertTaishiLibraryIndexRows(
  existing: TaishiLibraryIndexPage | undefined,
  upserts: readonly TaishiLibraryIndexRow[],
): TaishiLibraryIndexPage {
  const byIssue = new Map<number, TaishiLibraryIndexRow>();
  if (existing !== undefined) {
    for (const row of existing.rows) {
      byIssue.set(row.issueNumber, row);
    }
  }
  for (const row of upserts) {
    byIssue.set(row.issueNumber, row);
  }
  return buildTaishiLibraryIndexPage([...byIssue.values()]);
}

/**
 * Read existing library index, or undefined when absent.
 * Single typed producer writes this file — JSON.parse failure is loud.
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
