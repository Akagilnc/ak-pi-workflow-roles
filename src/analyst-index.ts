/**
 * Analyst library index page (ADR 0068 / PRD #298 output ②).
 *
 * Sweep mode maintains one self-sufficient row per issue:
 * 完全耗时 / 排除后改动行数 / 耗时每千行 / 末次活动时间戳.
 * Rows carry their own sort keys — readers choose order (Story 6/8).
 *
 * #399 D9: retained solely for cohort (and sweep producers that feed it).
 * Ticket CLI query path must not read this index (no bootstrap prerequisite).
 * Row address includes book identity so cross-book same ticket numbers do not merge (D5).
 * C2 joins cohort groups by (bookKey, issueNumber) → page reference. Missing row =
 * typed vacancy entry — never silent skip, never live recompute.
 * #412: bare cohort issue numbers resolve inside one book; no cross-book silent find.
 * Legacy rows lacking bookKey heal via the single shared projectRoot→bookKey rule
 * (git common-dir when resolvable, else `root:<identity>`) on read/ingest (F1/F3).
 *
 * Multi-process issue/sweep writers coordinate the whole read→upsert→write
 * on one exclusive lock next to the index (atomic rename still prevents torn
 * JSON; the lock prevents lost-update across concurrent CLI processes).
 */
import { open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  physicalPathIdentity,
} from "./activation-ledger-topology.ts";
import { resolveAnalystBookKey } from "./analyst-book-key.ts";
import type {
  AnalystIssueMetricsPage,
  AnalystOptionalMetricNumber,
  AnalystOptionalTimestamp,
} from "./analyst-page.ts";

const LIBRARY_INDEX_LOCK_NAME = ".library-index.lock";
const LIBRARY_INDEX_LOCK_TIMEOUT_MS = 30_000;
const LIBRARY_INDEX_LOCK_RETRY_MS = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Exclusive create lock for the library-index read→upsert→write critical section.
 * Same-directory sibling of the index file; not a second index and not a daemon.
 */
async function withAnalystLibraryIndexLock<T>(
  ledgerHome: string,
  fn: () => Promise<T>,
): Promise<T> {
  const indexPath = analystLibraryIndexPath(ledgerHome);
  ensureRealDirectoryTree(ledgerHome, dirname(indexPath));
  const lockPath = join(dirname(indexPath), LIBRARY_INDEX_LOCK_NAME);
  assertLedgerFileInsideHome(lockPath, ledgerHome);
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "EEXIST") throw error;
      if (Date.now() - startedAt > LIBRARY_INDEX_LOCK_TIMEOUT_MS) {
        throw new Error(
          `analyst library-index lock timeout after ${LIBRARY_INDEX_LOCK_TIMEOUT_MS}ms: ${lockPath}`,
        );
      }
      await sleep(LIBRARY_INDEX_LOCK_RETRY_MS);
    }
  }
}

/**
 * One issue row on the library index.
 * bookKey = book identity (page address component; #399 D5).
 * projectRoot = retained recording/display face (not sole address key after ADR 0068 revision).
 * issueNumber = optional caller typed field retained for cohort join.
 * C1 four columns make the row self-sufficient for cross-issue listing.
 */
export type AnalystLibraryIndexRow = {
  readonly bookKey: string;
  readonly projectRoot: string;
  /** Caller typed issue number — present when issue-mode supplied it for cohort join. */
  readonly issueNumber?: number;
  /** 完全耗时 — Σ readable leg wall clocks. */
  readonly totalElapsedMs: number;
  /** 排除后改动行数 — caller typed input; may be typed 空缺. */
  readonly changedLines: AnalystOptionalMetricNumber;
  /** 耗时/千行 — absent when LOC absent/0 (never 0 or ∞ stand-in). */
  readonly msPerKLines: AnalystOptionalMetricNumber;
  /** 末次活动时间戳 — max end-frame across ALL runs (incl. unreadable available). */
  readonly lastActivityAt: AnalystOptionalTimestamp;
};

/**
 * Library index page — unique true source for cross-issue listing / cohort join.
 * No md second projection; render on demand.
 */
export type AnalystLibraryIndexPage = {
  readonly kind: "analyst-library-index";
  readonly rows: readonly AnalystLibraryIndexRow[];
};

export function analystLibraryIndexPath(ledgerHome: string): string {
  return join(ledgerHome, "analyst", "library-index.json");
}

export function rowFromIssueMetricsPage(
  page: AnalystIssueMetricsPage,
): AnalystLibraryIndexRow {
  return {
    bookKey: page.bookKey,
    projectRoot: page.projectRoot,
    // exactOptionalPropertyTypes: only materialize when page carries it.
    ...(page.issueNumber === undefined ? {} : { issueNumber: page.issueNumber }),
    totalElapsedMs: page.totalElapsedMs,
    changedLines: page.changedLines,
    msPerKLines: page.msPerKLines,
    lastActivityAt: page.lastActivityAt,
  };
}

/**
 * #412 F1/F3: pre-#399 library-index rows omit bookKey. Heal with the single
 * shared projectRoot→bookKey rule (#399 / ADR 0048) — the same rule the
 * issue/sweep path uses, never a second resolver.
 */
export function normalizeAnalystLibraryIndexRow(
  row: AnalystLibraryIndexRow,
): AnalystLibraryIndexRow {
  const rawBook = (row as { readonly bookKey?: unknown }).bookKey;
  if (typeof rawBook === "string" && rawBook !== "") {
    if (rawBook === row.bookKey) return row;
    return { ...row, bookKey: rawBook };
  }
  const projectRoot = physicalPathIdentity(row.projectRoot);
  return { ...row, projectRoot, bookKey: resolveAnalystBookKey(projectRoot) };
}

function sortRows(
  rows: readonly AnalystLibraryIndexRow[],
): AnalystLibraryIndexRow[] {
  // Stable book → projectRoot sort (C1 listing). Cohort join is by (book, issue) find,
  // not row order — issueNumber secondary keeps C2 rows deterministic too.
  return [...rows].sort((a, b) => {
    const byBook = a.bookKey.localeCompare(b.bookKey);
    if (byBook !== 0) return byBook;
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
export function buildAnalystLibraryIndexPage(
  rows: readonly AnalystLibraryIndexRow[],
): AnalystLibraryIndexPage {
  return {
    kind: "analyst-library-index",
    rows: sortRows(rows.map(normalizeAnalystLibraryIndexRow)),
  };
}

/**
 * Look up the index row for (bookKey, issueNumber).
 * #412: no cross-book silent scan — caller supplies the book (cwd book or book:N).
 * Absence is a lawful cohort vacancy signal — not an error.
 */
export function findAnalystLibraryIndexRow(
  index: AnalystLibraryIndexPage | undefined,
  issueNumber: number,
  bookKey: string,
): AnalystLibraryIndexRow | undefined {
  if (index === undefined) return undefined;
  return index.rows.find(
    (row) => row.issueNumber === issueNumber && row.bookKey === bookKey,
  );
}

/** Row map key: book + root keeps cross-book same-ticket rows distinct (D5). */
function indexRowKey(row: Pick<AnalystLibraryIndexRow, "bookKey" | "projectRoot">): string {
  return `${row.bookKey}\0${row.projectRoot}`;
}

/** Within one book, issueNumber stays unique for cohort join. */
function issueBookKey(bookKey: string, issueNumber: number): string {
  return `${bookKey}\0${issueNumber}`;
}

/**
 * Upsert issue rows into an existing index (or empty).
 * - One row per (bookKey, projectRoot) — re-sweep overwrites that issue's row only (C1).
 * - When issueNumber is present, unique per (bookKey, issueNumber) — re-issue
 *   overwrites that number's row only within the book (C2; D5 cross-book safe).
 */
export function upsertAnalystLibraryIndexRows(
  existing: AnalystLibraryIndexPage | undefined,
  upserts: readonly AnalystLibraryIndexRow[],
): AnalystLibraryIndexPage {
  const byKey = new Map<string, AnalystLibraryIndexRow>();
  const keyByIssue = new Map<string, string>();

  const ingest = (row: AnalystLibraryIndexRow): void => {
    row = normalizeAnalystLibraryIndexRow(row);
    const key = indexRowKey(row);
    // C2 uniqueness within book: one row per issueNumber — drop prior if number moved.
    if (row.issueNumber !== undefined) {
      const issueKey = issueBookKey(row.bookKey, row.issueNumber);
      const priorKey = keyByIssue.get(issueKey);
      if (priorKey !== undefined && priorKey !== key) {
        byKey.delete(priorKey);
      }
    }
    // C1 uniqueness: one row per (book, projectRoot) — drop prior issue map if root reused.
    const prior = byKey.get(key);
    if (
      prior !== undefined
      && prior.issueNumber !== undefined
      && prior.issueNumber !== row.issueNumber
    ) {
      keyByIssue.delete(issueBookKey(prior.bookKey, prior.issueNumber));
    }
    byKey.set(key, row);
    if (row.issueNumber !== undefined) {
      keyByIssue.set(issueBookKey(row.bookKey, row.issueNumber), key);
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
  return buildAnalystLibraryIndexPage([...byKey.values()]);
}

/**
 * Read existing library index, or undefined when absent.
 * Single typed producer writes this file — JSON.parse failure is loud; a
 * syntactically valid but malformed shape (null / non-object / rows not an
 * array) is rejected at this sole read boundary with the file path and real
 * shape, so no type assertion lets garbage reach consumers (#413 r2 U1).
 */
export async function readAnalystLibraryIndexPage(
  ledgerHome: string,
): Promise<AnalystLibraryIndexPage | undefined> {
  const path = analystLibraryIndexPath(ledgerHome);
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
  const parsed: unknown = JSON.parse(raw);
  if (
    parsed === null
    || typeof parsed !== "object"
    || !Array.isArray((parsed as { readonly rows?: unknown }).rows)
  ) {
    const shape = parsed === null
      ? "null"
      : typeof parsed !== "object"
      ? typeof parsed
      : `object with non-array rows (${typeof (parsed as { rows?: unknown }).rows})`;
    throw new Error(
      `analyst library-index at ${path} is malformed (${shape}; expected an index page with a rows array) — rejected at the read boundary`,
    );
  }
  // Heal legacy rows at the read boundary so every consumer sees defined bookKey.
  return buildAnalystLibraryIndexPage((parsed as AnalystLibraryIndexPage).rows);
}

/**
 * Atomically replace the library index page.
 * Directory creation goes through ledger home physical containment.
 * Prefer {@link mergeAnalystLibraryIndexRows} for multi-writer updates — bare
 * write has no read→merge coordination.
 */
export async function writeAnalystLibraryIndexPage(
  ledgerHome: string,
  page: AnalystLibraryIndexPage,
): Promise<string> {
  const path = analystLibraryIndexPath(ledgerHome);
  ensureRealDirectoryTree(ledgerHome, dirname(path));
  assertLedgerFileInsideHome(path, ledgerHome);
  await writeFileAtomically(path, `${JSON.stringify(page, null, 2)}\n`);
  return path;
}

/**
 * Sole multi-writer coordination seam for library-index updates.
 * Holds one exclusive lock across read → upsert → atomic write so concurrent
 * issue/sweep CLI processes cannot drop each other's new rows.
 */
export async function mergeAnalystLibraryIndexRows(
  ledgerHome: string,
  upserts: readonly AnalystLibraryIndexRow[],
): Promise<{ readonly index: AnalystLibraryIndexPage; readonly indexPath: string }> {
  return withAnalystLibraryIndexLock(ledgerHome, async () => {
    const existing = await readAnalystLibraryIndexPage(ledgerHome);
    const index = upsertAnalystLibraryIndexRows(existing, upserts);
    const indexPath = await writeAnalystLibraryIndexPage(ledgerHome, index);
    return { index, indexPath };
  });
}
