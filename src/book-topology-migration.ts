import { mkdir, readdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  physicalPathIdentity,
  physicallyContainedIn,
} from "./activation-ledger-topology.ts";
import {
  autopsyWriterLock,
  describeErrorIdentity,
} from "./public-cli/run-lifecycle.ts";
export type MigrationDisposition = "placed" | "unbound" | "discarded";

export type MigrationItemOutcome =
  | {
      readonly disposition: MigrationDisposition;
      /** Source-relative identity of the directory, file, or JSONL row. */
      readonly source: string;
    }
  | {
      readonly disposition: "unbound";
      readonly source: string;
      readonly malformed: true;
      /** Exact source bytes are mandatory for every malformed JSONL row. */
      readonly malformedRaw: string;
    };

export type MigrationPartitionReport = {
  readonly partition: string;
  readonly unit: "entries" | "lines";
  readonly before: number;
  readonly placed: number;
  readonly unbound: number;
  readonly discarded: number;
  readonly malformedRows: readonly {
    readonly source: string;
    readonly raw: string;
  }[];
};

export type BookTopologyMigrationContext = {
  /** Immutable source after the atomic books/ rename. */
  readonly backupBooksDirectory: string;
  /** Fresh destination at the former books/ path. */
  readonly booksDirectory: string;
};

export type BookTopologyPartitionMigrator = {
  readonly partition: string;
  migrate(context: BookTopologyMigrationContext): Promise<MigrationPartitionReport>;
};

export type BookTopologyMigrationReport = {
  readonly backupBooksDirectory: string;
  readonly booksDirectory: string;
  readonly partitions: readonly MigrationPartitionReport[];
};

/** Shared reconciliation projection. Counting outcomes makes the closure true by construction. */
export function reconcileMigrationPartition(
  partition: string,
  unit: MigrationPartitionReport["unit"],
  outcomes: readonly MigrationItemOutcome[],
): MigrationPartitionReport {
  let placed = 0;
  let unbound = 0;
  let discarded = 0;
  const malformedRows: { source: string; raw: string }[] = [];

  for (const outcome of outcomes) {
    if (outcome.disposition === "placed") placed += 1;
    else if (outcome.disposition === "unbound") unbound += 1;
    else discarded += 1;
    if ("malformed" in outcome) {
      malformedRows.push({ source: outcome.source, raw: outcome.malformedRaw });
    }
  }

  return {
    partition,
    unit,
    before: outcomes.length,
    placed,
    unbound,
    discarded,
    malformedRows,
  };
}

async function findWriterLocks(root: string): Promise<string[]> {
  const locks: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "writer.lock") locks.push(path);
    }
  }
  await walk(root);
  return locks;
}

/**
 * Refuse migration from a role whose canonical dossier is inside books/, and
 * while a writer lease proves a run is currently active. Retained lifecycle
 * state is history, not holder liveness.
 */
export async function assertBookTopologyMigrationPrerequisites(
  booksDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runDirectory = env.AK_ROLE_RUN_DIR;
  if (
    runDirectory !== undefined
    && (physicalPathIdentity(booksDirectory) === physicalPathIdentity(runDirectory)
      || physicallyContainedIn(booksDirectory, runDirectory))
  ) {
    throw new Error(
      `book topology migration cannot run from a role dossier inside books/: ${runDirectory}`,
    );
  }

  const active: string[] = [];
  for (const lockPath of await findWriterLocks(booksDirectory)) {
    const holder = await autopsyWriterLock(lockPath);
    if (holder.verdict === "alive") {
      active.push(`${lockPath} (live pid ${holder.pid})`);
    } else if (holder.verdict === "unknown") {
      const cause = holder.reason === "unreadable"
        ? `unreadable: ${describeErrorIdentity(holder.readFailure)}`
        : `unparseable holder: ${JSON.stringify(holder.content)}`;
      throw new Error(`cannot establish zero in-flight runs from ${lockPath}: ${cause}`);
    }
  }
  if (active.length > 0) {
    throw new Error(`book topology migration requires zero in-flight runs:\n${active.join("\n")}`);
  }
}

export function datedBooksBackupDirectory(
  booksDirectory: string,
  now: Date = new Date(),
): string {
  const date = now.toISOString().slice(0, 10);
  return join(dirname(booksDirectory), `${basename(booksDirectory)}-${date}`);
}

/** Atomic same-parent rename: the readable pre-migration tree is never packed. */
export async function renameBooksToDatedBackup(
  booksDirectory: string,
  now: Date = new Date(),
): Promise<string> {
  const backup = datedBooksBackupDirectory(booksDirectory, now);
  await rename(booksDirectory, backup);
  return backup;
}

export async function migrateBookTopology(input: {
  readonly ledgerHome?: string;
  readonly now?: Date;
  readonly migrators: readonly BookTopologyPartitionMigrator[];
  readonly env?: NodeJS.ProcessEnv;
}): Promise<BookTopologyMigrationReport> {
  if (input.migrators.length === 0) {
    throw new Error("book topology migration has no partition migrators");
  }
  const ledgerHome = resolve(input.ledgerHome ?? join(homedir(), ".ak-roles"));
  const booksDirectory = join(ledgerHome, "books");
  await assertBookTopologyMigrationPrerequisites(booksDirectory, input.env);
  const backupBooksDirectory = await renameBooksToDatedBackup(booksDirectory, input.now);
  await mkdir(booksDirectory);

  const context = { backupBooksDirectory, booksDirectory };
  const partitions: MigrationPartitionReport[] = [];
  for (const migrator of input.migrators) {
    const report = await migrator.migrate(context);
    if (report.partition !== migrator.partition) {
      throw new Error(`partition report mismatch: expected ${migrator.partition}, received ${report.partition}`);
    }
    if (report.before !== report.placed + report.unbound + report.discarded) {
      throw new Error(`partition reconciliation did not close: ${report.partition}`);
    }
    partitions.push(report);
  }
  return { backupBooksDirectory, booksDirectory, partitions };
}
