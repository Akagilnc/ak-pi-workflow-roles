/**
 * #865 T9: migrate retained runs into ticket-scoped or unbound placement.
 * Inventory covers legacy flat `runs/`, existing `<ticket>/runs/`, and
 * `unbound/runs/`. Attribution reuses the shared migrating-run helper;
 * already-canonical ticket trees copy as-is. Unbound leaves that already
 * hold a board typed ticketNumber place under that ticket (#863 stock).
 */
import { cp, mkdir, rename, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  destinationRunDirectory,
  isMigrationEnoent,
  isTicketNumberString,
  listBackupRunLeaves,
  listMigrationBookKeys,
  resolveMigratingRunTicket,
} from "./book-topology-migration-placement.ts";
import {
  holdBoardBoundUnboundRelocateClosure,
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import type { RunWriterLease } from "./public-cli/run-lifecycle.ts";
import { listBookRunDirectories } from "./role-run-placement.ts";
import {
  rewriteRoleRunDurablePages,
  type RunDirectoryPathRewrite,
} from "./role-run-relocation.ts";
import {
  MIGRATION_TICKET_DERIVATION_PAGE,
  readBoardTicketNumber,
} from "./run-ticket-number.ts";

const RUNS_PARTITION = "runs";

const RUN_LEAF =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9_-]*)$/;

type RunLeaf = { readonly runId: string; readonly role: string };

type PlannedRunMove = {
  readonly sourcePath: string;
  readonly sourceIdentity: string;
  readonly isDirectory: boolean;
  readonly disposition: "placed" | "unbound";
  readonly targetPath: string;
  readonly historicalRunDirectory: string | undefined;
  readonly derivation:
    | { readonly ticketNumber: number; readonly projectRoot: string; readonly sourcePage: string }
    | undefined;
};

function parseRunLeaf(name: string): RunLeaf | undefined {
  const match = RUN_LEAF.exec(name);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMigrationEnoent(error)) return false;
    throw error;
  }
}

async function writeDerivationPage(
  targetRunDirectory: string,
  derivation: {
    readonly ticketNumber: number;
    readonly projectRoot: string;
    readonly sourcePage: string;
  },
): Promise<void> {
  const page = {
    ticketNumber: derivation.ticketNumber,
    derivation: "worktree-path-basename" as const,
    source: {
      page: derivation.sourcePage,
      field: "projectRoot",
      path: derivation.projectRoot,
      basename: basename(derivation.projectRoot),
    },
  };
  await writeFile(
    join(targetRunDirectory, MIGRATION_TICKET_DERIVATION_PAGE),
    `${JSON.stringify(page, null, 2)}\n`,
    "utf8",
  );
}

async function copyRunTree(
  source: string,
  target: string,
  isDirectory: boolean,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (isDirectory) {
    await cp(source, target, { recursive: true, preserveTimestamps: true });
    return;
  }
  await cp(source, target, { preserveTimestamps: true });
}

async function planBookMoves(
  backupBooksDirectory: string,
  booksDirectory: string,
  bookKey: string,
): Promise<readonly PlannedRunMove[]> {
  const backupBook = join(backupBooksDirectory, bookKey);
  const claimed = new Map<string, string>();
  const planned: PlannedRunMove[] = [];

  for (const leaf of await listBackupRunLeaves(backupBook)) {
    const sourceIdentity = relative(backupBooksDirectory, leaf.sourcePath)
      .split(sep)
      .join("/");
    const parsed = leaf.isDirectory ? parseRunLeaf(leaf.leafName) : undefined;

    let targetPath: string;
    let disposition: "placed" | "unbound";
    let historicalRunDirectory: string | undefined;
    let derivation: PlannedRunMove["derivation"];

    if (leaf.layout === "issues") {
      // issues/<ticket>/runs/<leaf> → <ticket>/runs/<leaf>; conflict refuses below.
      const parts = leaf.relativePath.replaceAll("\\", "/").split("/");
      const ticketStr = parts[1];
      if (ticketStr !== undefined && isTicketNumberString(ticketStr)) {
        targetPath = join(booksDirectory, bookKey, ticketStr, "runs", leaf.leafName);
        disposition = "placed";
        historicalRunDirectory = join(
          booksDirectory,
          bookKey,
          "issues",
          ticketStr,
          "runs",
          leaf.leafName,
        );
      } else {
        targetPath = join(booksDirectory, bookKey, "unbound", "runs", leaf.leafName);
        disposition = "unbound";
        historicalRunDirectory = join(booksDirectory, bookKey, leaf.relativePath);
      }
      derivation = undefined;
    } else if (leaf.layout === "unbound") {
      // #863: board typed ticket on an unbound leaf → place under that ticket.
      // No board ticket → stay unbound. Never invent from prose or derivation.
      const boardTicket = leaf.isDirectory
        ? await readBoardTicketNumber(leaf.sourcePath)
        : undefined;
      if (parsed !== undefined && boardTicket !== undefined) {
        targetPath = destinationRunDirectory(
          booksDirectory,
          bookKey,
          boardTicket,
          parsed.runId,
          parsed.role,
        );
        disposition = "placed";
        historicalRunDirectory = join(
          booksDirectory,
          bookKey,
          "unbound",
          "runs",
          leaf.leafName,
        );
      } else {
        targetPath = join(booksDirectory, bookKey, leaf.relativePath);
        disposition = "unbound";
        historicalRunDirectory = undefined;
      }
      derivation = undefined;
    } else if (leaf.layout !== "flat") {
      // Already-canonical `<ticket>/runs/` — copy as-is.
      targetPath = join(booksDirectory, bookKey, leaf.relativePath);
      disposition = "placed";
      historicalRunDirectory = undefined;
      derivation = undefined;
    } else if (parsed === undefined) {
      targetPath = join(booksDirectory, bookKey, "unbound", "runs", leaf.leafName);
      disposition = "unbound";
      historicalRunDirectory = join(booksDirectory, bookKey, "runs", leaf.leafName);
      derivation = undefined;
    } else {
      const ticket = await resolveMigratingRunTicket(leaf.sourcePath);
      targetPath = destinationRunDirectory(
        booksDirectory,
        bookKey,
        ticket.ticketNumber,
        parsed.runId,
        parsed.role,
      );
      disposition = ticket.ticketNumber === undefined ? "unbound" : "placed";
      historicalRunDirectory = join(booksDirectory, bookKey, "runs", leaf.leafName);
      derivation =
        ticket.derivation?.method === "project-root-basename"
          && ticket.ticketNumber !== undefined
          ? {
              ticketNumber: ticket.ticketNumber,
              projectRoot: ticket.derivation.source,
              sourcePage: ticket.derivation.sourcePage,
            }
          : undefined;
    }

    const prior = claimed.get(targetPath);
    if (prior !== undefined) {
      throw new Error(
        `book topology migration refuses to overwrite ${targetPath} (already claimed by ${prior}) with ${leaf.sourcePath}`,
      );
    }
    claimed.set(targetPath, leaf.sourcePath);
    planned.push({
      sourcePath: leaf.sourcePath,
      sourceIdentity,
      isDirectory: leaf.isDirectory,
      disposition,
      targetPath,
      historicalRunDirectory,
      derivation,
    });
  }
  return planned;
}

export const bookTopologyRunsMigrator: BookTopologyPartitionMigrator = {
  partition: RUNS_PARTITION,
  async migrate(context: BookTopologyMigrationContext) {
    const outcomes: MigrationItemOutcome[] = [];
    const { backupBooksDirectory, booksDirectory } = context;

    for (const bookKey of await listMigrationBookKeys(backupBooksDirectory)) {
      const planned = await planBookMoves(
        backupBooksDirectory,
        booksDirectory,
        bookKey,
      );

      const crossRunRewrites: RunDirectoryPathRewrite[] = planned
        .filter((move) => move.isDirectory && move.historicalRunDirectory !== undefined)
        .map((move) => ({
          oldRunDirectory: move.historicalRunDirectory!,
          newRunDirectory: move.targetPath,
        }));

      for (const move of planned) {
        if (await pathExists(move.targetPath)) {
          throw new Error(
            `book topology migration refuses to overwrite ${move.targetPath} with ${move.sourcePath}`,
          );
        }
        await copyRunTree(move.sourcePath, move.targetPath, move.isDirectory);
        if (move.isDirectory) {
          await rewriteRoleRunDurablePages({
            pagesDirectory: move.targetPath,
            oldRunDirectory: move.historicalRunDirectory ?? move.targetPath,
            newRunDirectory: move.targetPath,
            crossRunRewrites,
          });
        }
        if (move.isDirectory && move.derivation !== undefined) {
          await writeDerivationPage(move.targetPath, move.derivation);
        }

        outcomes.push({
          disposition: move.disposition,
          source: move.sourceIdentity,
        });
      }
    }

    return reconcileMigrationPartition(RUNS_PARTITION, "entries", outcomes);
  },
};

export type BoardBoundUnboundRelocation = {
  readonly from: string;
  readonly to: string;
  readonly ticketNumber: number;
};

type PlannedBoardBoundMove = {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly ticketNumber: number;
};

/**
 * Read-only plan of board-bound unbound→ticket moves for one book. No
 * filesystem mutation. Books with zero planned moves are outside the #863
 * mutation closure (#986).
 */
async function planBoardBoundUnboundMovesInBook(
  bookDirectory: string,
): Promise<readonly PlannedBoardBoundMove[]> {
  const bookKey = basename(bookDirectory);
  const booksDirectory = dirname(bookDirectory);
  const unboundRuns = join(bookDirectory, "unbound", "runs");
  let entries;
  try {
    entries = await readdir(unboundRuns, { withFileTypes: true });
  } catch (error) {
    if (isMigrationEnoent(error)) return [];
    throw error;
  }

  const planned: PlannedBoardBoundMove[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseRunLeaf(entry.name);
    if (parsed === undefined) continue;
    const sourcePath = join(unboundRuns, entry.name);
    const boardTicket = await readBoardTicketNumber(sourcePath);
    if (boardTicket === undefined) continue;
    const targetPath = destinationRunDirectory(
      booksDirectory,
      bookKey,
      boardTicket,
      parsed.runId,
      parsed.role,
    );
    planned.push({
      sourcePath,
      targetPath,
      ticketNumber: boardTicket,
    });
  }
  return planned;
}

/**
 * Apply a previously planned board-bound batch against a frozen run-directory
 * snapshot: refuse overwrite, rewrite durable pages (including batch
 * `crossRunRewrites`) while sources still sit at unbound, then rename.
 * Does not re-enumerate the book — post-gate runs must not expand the write
 * set (#986 TOCTOU). Parse/write failures leave sources in place so a retry
 * can finish the same closure.
 */
async function applyBoardBoundUnboundMovesInBook(
  planned: readonly PlannedBoardBoundMove[],
  frozenRunDirectories: readonly string[],
  leasesByRunDirectory: ReadonlyMap<string, RunWriterLease>,
): Promise<readonly BoardBoundUnboundRelocation[]> {
  if (planned.length === 0) return [];

  for (const move of planned) {
    if (await pathExists(move.targetPath)) {
      throw new Error(
        `board-bound unbound relocate refuses to overwrite ${move.targetPath} with ${move.sourcePath}`,
      );
    }
  }

  const crossRunRewrites: RunDirectoryPathRewrite[] = planned.map((move) => ({
    oldRunDirectory: move.sourcePath,
    newRunDirectory: move.targetPath,
  }));
  const relocatedBySource = new Map(
    planned.map((move) => [move.sourcePath, move] as const),
  );

  // Rewrite before any rename so durable-page failures remain retryable from
  // the same unbound sources (failure-honesty: no relocatedCount=0 whitewash).
  for (const runDir of frozenRunDirectories) {
    const move = relocatedBySource.get(runDir);
    await rewriteRoleRunDurablePages({
      pagesDirectory: runDir,
      oldRunDirectory: move?.sourcePath ?? runDir,
      newRunDirectory: move?.targetPath ?? runDir,
      crossRunRewrites,
    });
  }

  for (const move of planned) {
    await mkdir(dirname(move.targetPath), { recursive: true });
    await rename(move.sourcePath, move.targetPath);
    // Directory rename moves writer.lock with the tree; keep lease release
    // anchored at the new path (shared RunWriterLease.relocate seam).
    leasesByRunDirectory.get(move.sourcePath)?.relocate(move.targetPath);
  }

  return planned.map((move) => ({
    from: move.sourcePath,
    to: move.targetPath,
    ticketNumber: move.ticketNumber,
  }));
}

/**
 * Walk every book under `booksDirectory` and relocate board-bound unbound
 * runs in place. Gate (#986) covers only the frozen mutation closure: every
 * run directory in every book that has ≥1 planned board-bound move at plan
 * time. The ordinary writer lease is held on that frozen set through
 * rewrite/rename so writers cannot enter the window; apply never re-enumerates
 * the book. Outside-closure locks do not refuse; recycled PIDs are not treated
 * as the original holder. #860 whole-books gate stays separate.
 */
export async function relocateBoardBoundUnboundRunsInBooks(
  booksDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly BoardBoundUnboundRelocation[]> {
  type BookBatch = {
    readonly bookDirectory: string;
    readonly planned: readonly PlannedBoardBoundMove[];
    readonly frozenRunDirectories: readonly string[];
  };
  const batches: BookBatch[] = [];
  const mutationClosure: string[] = [];

  for (const bookKey of await listMigrationBookKeys(booksDirectory)) {
    const bookDirectory = join(booksDirectory, bookKey);
    const planned = await planBoardBoundUnboundMovesInBook(bookDirectory);
    if (planned.length === 0) {
      batches.push({ bookDirectory, planned, frozenRunDirectories: [] });
      continue;
    }
    // Freeze closure at plan time — apply must not listBookRunDirectories again.
    const frozenRunDirectories = await listBookRunDirectories(bookDirectory);
    batches.push({ bookDirectory, planned, frozenRunDirectories });
    mutationClosure.push(...frozenRunDirectories);
  }

  const leases = await holdBoardBoundUnboundRelocateClosure(
    booksDirectory,
    mutationClosure,
    env,
  );
  const leasesByRunDirectory = new Map<string, RunWriterLease>();
  for (let i = 0; i < mutationClosure.length; i += 1) {
    leasesByRunDirectory.set(mutationClosure[i]!, leases[i]!);
  }

  try {
    const relocated: BoardBoundUnboundRelocation[] = [];
    for (const batch of batches) {
      const moved = await applyBoardBoundUnboundMovesInBook(
        batch.planned,
        batch.frozenRunDirectories,
        leasesByRunDirectory,
      );
      relocated.push(...moved);
    }
    return relocated;
  } finally {
    for (const lease of leases) {
      await lease.release();
    }
  }
}
