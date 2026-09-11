import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type MigrationDisposition = "placed" | "unbound" | "discarded";

export type MigrationItemOutcome = {
  readonly disposition: MigrationDisposition;
  /** Source-relative identity of the directory, file, or JSONL row. */
  readonly source: string;
  /** Required for a malformed JSONL row so the evidence preserves its exact bytes. */
  readonly malformedRaw?: string;
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
    if (outcome.malformedRaw !== undefined) {
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

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function findRunStateFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "run-state.json") found.push(path);
    }
  }
  await walk(root);
  return found;
}

/**
 * Refuse migration from a role whose canonical dossier is inside books/, and
 * refuse while any retained run is non-terminal. Unknown state cannot prove a
 * zero-in-flight window, so it fails with its source path intact.
 */
export async function assertBookTopologyMigrationPrerequisites(
  booksDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runDirectory = env.AK_ROLE_RUN_DIR;
  if (runDirectory !== undefined && isWithin(booksDirectory, runDirectory)) {
    throw new Error(
      `book topology migration cannot run from a role dossier inside books/: ${runDirectory}`,
    );
  }

  const active: string[] = [];
  for (const statePath of await findRunStateFiles(booksDirectory)) {
    let state: unknown;
    try {
      const page: unknown = JSON.parse(await readFile(statePath, "utf8"));
      state = typeof page === "object" && page !== null && "state" in page
        ? (page as { state?: unknown }).state
        : undefined;
    } catch (error) {
      throw new Error(`cannot establish zero in-flight runs from ${statePath}`, { cause: error });
    }
    if (typeof state !== "string") {
      throw new Error(`cannot establish zero in-flight runs from ${statePath}: missing state`);
    }
    if (state === "admitted" || state === "running" || state === "resumable") {
      active.push(statePath);
    } else if (state !== "terminal") {
      throw new Error(`cannot establish zero in-flight runs from ${statePath}: unknown state ${state}`);
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
