/**
 * #865 T9: migrate retained runs into ticket-scoped or unbound placement.
 * Inventory covers legacy flat `runs/`, existing `<ticket>/runs/`, and
 * `unbound/runs/`. Attribution reuses the shared migrating-run helper;
 * already-canonical trees copy as-is.
 */
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  destinationRunDirectory,
  listBackupRunLeaves,
  resolveMigratingRunTicket,
} from "./book-topology-migration-placement.ts";
import {
  reconcileMigrationPartition,
  type BookTopologyMigrationContext,
  type BookTopologyPartitionMigrator,
  type MigrationItemOutcome,
} from "./book-topology-migration.ts";
import {
  rewriteRoleRunDurablePages,
  type RunDirectoryPathRewrite,
} from "./role-run-relocation.ts";
import { MIGRATION_TICKET_DERIVATION_PAGE } from "./run-ticket-number.ts";

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

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function listBookKeys(backupBooksDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(backupBooksDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
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

    if (leaf.layout !== "flat") {
      targetPath = join(booksDirectory, bookKey, leaf.relativePath);
      disposition = leaf.layout === "unbound" ? "unbound" : "placed";
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

    for (const bookKey of await listBookKeys(backupBooksDirectory)) {
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
        if (move.isDirectory && move.historicalRunDirectory !== undefined) {
          await rewriteRoleRunDurablePages({
            pagesDirectory: move.targetPath,
            oldRunDirectory: move.historicalRunDirectory,
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
