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
  assertBookTopologyMigrationPrerequisites,
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
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

/**
 * Live in-place repair for already-migrated trees (#863 stock): rename each
 * `unbound/runs/<runId>@<role>` that holds a board typed ticketNumber into
 * `<ticket>/runs/…`, rewriting durable pages through the shared relocation
 * seam. Leaves without a board ticket stay unbound. Refuses overwrite.
 */
export async function relocateBoardBoundUnboundRunsInBook(
  bookDirectory: string,
): Promise<readonly BoardBoundUnboundRelocation[]> {
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

  const relocated: BoardBoundUnboundRelocation[] = [];
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
    if (await pathExists(targetPath)) {
      throw new Error(
        `board-bound unbound relocate refuses to overwrite ${targetPath} with ${sourcePath}`,
      );
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await rename(sourcePath, targetPath);
    await rewriteRoleRunDurablePages({
      pagesDirectory: targetPath,
      oldRunDirectory: sourcePath,
      newRunDirectory: targetPath,
    });
    relocated.push({
      from: sourcePath,
      to: targetPath,
      ticketNumber: boardTicket,
    });
  }
  return relocated;
}

/**
 * Walk every book under `booksDirectory` and relocate board-bound unbound
 * runs in place. Requires zero live writer locks (same gate as topology migrate).
 */
export async function relocateBoardBoundUnboundRunsInBooks(
  booksDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly BoardBoundUnboundRelocation[]> {
  await assertBookTopologyMigrationPrerequisites(booksDirectory, env);
  const relocated: BoardBoundUnboundRelocation[] = [];
  for (const bookKey of await listMigrationBookKeys(booksDirectory)) {
    const batch = await relocateBoardBoundUnboundRunsInBook(
      join(booksDirectory, bookKey),
    );
    relocated.push(...batch);
  }
  return relocated;
}
