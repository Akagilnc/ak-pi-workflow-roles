import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  physicalPathIdentity,
  physicallyContainedIn,
} from "./activation-ledger-topology.ts";
import {
  acquireRunWriterLease,
  autopsyWriterLock,
  describeErrorIdentity,
  RunWriterLeaseHeldError,
  type RunWriterLease,
  type WriterLeaseDiagnosticKind,
} from "./public-cli/run-lifecycle.ts";

/** Same cleanup-diagnostic seam as acquireRunWriterLease callers (CLI stderr). */
export type MutationClosureLeaseCleanupDiagnostic = (
  diagnostic: string,
  kind?: WriterLeaseDiagnosticKind,
) => void;

function defaultMutationClosureCleanupDiagnostic(diagnostic: string): void {
  process.stderr.write(diagnostic);
}

const execFileAsync = promisify(execFile);
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

type WriterLockCandidate = {
  readonly path: string;
  readonly regularFile: boolean;
  readonly kind: string;
};

type WriterLockFsShape = {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
};

/** Sole label for writer.lock filesystem object kinds (Dirent or Stats). */
function writerLockFilesystemKind(entry: WriterLockFsShape): string {
  return entry.isFile() ? "file"
    : entry.isDirectory() ? "directory"
    : entry.isSymbolicLink() ? "symbolic link"
    : entry.isFIFO() ? "FIFO"
    : entry.isSocket() ? "socket"
    : entry.isCharacterDevice() ? "character device"
    : entry.isBlockDevice() ? "block device"
    : "unknown filesystem object";
}

async function findWriterLocks(root: string): Promise<WriterLockCandidate[]> {
  const locks: WriterLockCandidate[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === "writer.lock") {
        locks.push({
          path,
          regularFile: entry.isFile(),
          kind: writerLockFilesystemKind(entry),
        });
      } else if (entry.isDirectory()) {
        await walk(path);
      }
    }
  }
  await walk(root);
  return locks;
}

function assertNotRunningFromBooksDossier(
  booksDirectory: string,
  env: NodeJS.ProcessEnv,
  operationLabel: string,
): void {
  const runDirectory = env.AK_ROLE_RUN_DIR;
  if (
    runDirectory !== undefined
    && (physicalPathIdentity(booksDirectory) === physicalPathIdentity(runDirectory)
      || physicallyContainedIn(booksDirectory, runDirectory))
  ) {
    throw new Error(
      `${operationLabel} cannot run from a role dossier inside books/: ${runDirectory}`,
    );
  }
}

/**
 * Process start time via `ps -p <pid> -o lstart=` (portable on macOS/Linux).
 * Signal-0 only proves a PID exists; start-vs-lock-mtime discriminates recycled
 * PIDs for migration gates that opt in. Shared lease acquire must NOT use this.
 *
 * `lstart` is whole-second only; callers must not compare it to millisecond
 * mtime as if sub-second order were knowable (#986).
 */
async function readProcessStartTimeMs(
  pid: number,
): Promise<"absent" | "unreadable" | number> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8" },
    );
    const text = stdout.trim();
    if (text === "") return "absent";
    const startMs = Date.parse(text);
    if (!Number.isFinite(startMs)) {
      return "unreadable";
    }
    return startMs;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // `ps` exits 1 when the pid is gone between autopsy and this probe.
    if (code === 1) return "absent";
    return "unreadable";
  }
}

/** Recycled-PID identity relative to a lock mtime, given whole-second `lstart`. */
type RecycledPidIdentity =
  | { readonly kind: "recycled" }
  | { readonly kind: "original-holder" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "unconfirmable";
      readonly reason: "unreadable-start" | "same-second";
    };

/**
 * Classify whether a signal-0-alive pid is the original lock holder.
 * Only a strictly later wall-clock second than the lock mtime proves recycle;
 * the same second is identity-unconfirmable (never treated as original-live).
 */
async function classifyRecycledPidIdentity(
  pid: number,
  lockMtimeMs: number,
): Promise<RecycledPidIdentity> {
  const start = await readProcessStartTimeMs(pid);
  if (start === "absent") return { kind: "absent" };
  if (start === "unreadable") {
    return { kind: "unconfirmable", reason: "unreadable-start" };
  }
  const startSec = Math.floor(start / 1000);
  const lockSec = Math.floor(lockMtimeMs / 1000);
  if (startSec > lockSec) return { kind: "recycled" };
  if (startSec === lockSec) {
    return { kind: "unconfirmable", reason: "same-second" };
  }
  return { kind: "original-holder" };
}

type WriterLockGatePolicy = {
  readonly refuseLabel: string;
  readonly unverifiableLabel: string;
  /**
   * When true, an autopsy-"alive" pid whose process start falls in a strictly
   * later whole second than the lock mtime is treated as a recycled unrelated
   * holder (not blocking). Same-second or otherwise unconfirmable start fails
   * loud — never whitewashed as clear or as confirmed original-live.
   */
  readonly discriminateRecycledPid: boolean;
};

async function assertWriterLocksClear(
  lockCandidates: readonly WriterLockCandidate[],
  policy: WriterLockGatePolicy,
): Promise<void> {
  const active: string[] = [];
  for (const candidate of lockCandidates) {
    const lockPath = candidate.path;
    if (!candidate.regularFile) {
      throw new Error(
        `${policy.unverifiableLabel} from ${lockPath}: writer lock is a ${candidate.kind}, holder liveness unverifiable`,
      );
    }
    const holder = await autopsyWriterLock(lockPath);
    if (holder.verdict === "unknown") {
      const cause = holder.reason === "unreadable"
        ? `unreadable: ${describeErrorIdentity(holder.readFailure)}`
        : `unparseable holder: ${JSON.stringify(holder.content)}`;
      throw new Error(`${policy.unverifiableLabel} from ${lockPath}: ${cause}`);
    }
    if (holder.verdict !== "alive") continue;

    if (!policy.discriminateRecycledPid) {
      active.push(`${lockPath} (live pid ${holder.pid})`);
      continue;
    }

    let lockMtimeMs: number;
    try {
      lockMtimeMs = (await stat(lockPath)).mtimeMs;
    } catch (error) {
      throw new Error(
        `${policy.unverifiableLabel} from ${lockPath}: cannot read lock mtime for recycled-pid check: ${describeErrorIdentity(error)}`,
      );
    }
    const identity = await classifyRecycledPidIdentity(holder.pid, lockMtimeMs);
    if (identity.kind === "absent" || identity.kind === "recycled") {
      // Absent: exited between autopsy and ps. Recycled: unrelated reuse.
      continue;
    }
    if (identity.kind === "unconfirmable") {
      const detail = identity.reason === "same-second"
        ? `live pid ${holder.pid} start second equals lock mtime second (ps lstart is whole-second only; identity unconfirmable)`
        : `cannot confirm whether live pid ${holder.pid} is the original lock holder (process start time unreadable)`;
      throw new Error(`${policy.unverifiableLabel} from ${lockPath}: ${detail}`);
    }
    active.push(`${lockPath} (live pid ${holder.pid})`);
  }
  if (active.length > 0) {
    throw new Error(`${policy.refuseLabel}:\n${active.join("\n")}`);
  }
}

/**
 * Refuse migration from a role whose canonical dossier is inside books/, and
 * while a writer lease proves a run is currently active. Retained lifecycle
 * state is history, not holder liveness.
 *
 * #860 whole-books gate: scans every writer.lock under books/. Does not
 * discriminate recycled PIDs (signal-0 alive remains refuse).
 */
export async function assertBookTopologyMigrationPrerequisites(
  booksDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertNotRunningFromBooksDossier(booksDirectory, env, "book topology migration");
  await assertWriterLocksClear(await findWriterLocks(booksDirectory), {
    refuseLabel: "book topology migration requires zero in-flight runs",
    unverifiableLabel: "cannot establish zero in-flight runs",
    discriminateRecycledPid: false,
  });
}

const BOARD_BOUND_RELOCATE_REFUSE =
  "board-bound unbound relocate requires zero in-flight writers in mutation closure";
const BOARD_BOUND_RELOCATE_UNVERIFIABLE =
  "cannot establish mutation-closure writer liveness";

async function mutationClosureLockCandidates(
  mutationClosureRunDirectories: readonly string[],
): Promise<WriterLockCandidate[]> {
  const candidates: WriterLockCandidate[] = [];
  for (const runDirectory of mutationClosureRunDirectories) {
    const lockPath = join(runDirectory, "writer.lock");
    try {
      const st = await lstat(lockPath);
      candidates.push({
        path: lockPath,
        regularFile: st.isFile(),
        kind: writerLockFilesystemKind(st),
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") continue;
      throw error;
    }
  }
  return candidates;
}

/**
 * #863 / #986 relocate gate: only writer locks under the mutation-closure run
 * directories may block. Outside-closure locks (other books, non-rewritten
 * peers in untouched books) must not refuse. Recycled-PID holders that merely
 * reuse a historical lock's pid number are not treated as the original writer.
 */
export async function assertBoardBoundUnboundRelocatePrerequisites(
  booksDirectory: string,
  mutationClosureRunDirectories: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertNotRunningFromBooksDossier(
    booksDirectory,
    env,
    "board-bound unbound relocate",
  );
  if (mutationClosureRunDirectories.length === 0) return;

  await assertWriterLocksClear(
    await mutationClosureLockCandidates(mutationClosureRunDirectories),
    {
      refuseLabel: BOARD_BOUND_RELOCATE_REFUSE,
      unverifiableLabel: BOARD_BOUND_RELOCATE_UNVERIFIABLE,
      discriminateRecycledPid: true,
    },
  );
}

/**
 * Unlink a mutation-closure lock only when the live pid is proven recycled
 * (start second strictly after lock mtime second). Same-second stays
 * unconfirmable; original-holder stays contested. Does not alter shared
 * acquire/reclaim — this is the #863 gate's authorized orphan cleanup before
 * taking the ordinary writer lease for the mutation window.
 */
async function reclaimRecycledMutationClosureLock(
  lockPath: string,
): Promise<"reclaimed" | "not-recycled"> {
  const holder = await autopsyWriterLock(lockPath);
  if (holder.verdict !== "alive") return "not-recycled";
  let lockMtimeMs: number;
  try {
    lockMtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return "reclaimed";
    throw new Error(
      `${BOARD_BOUND_RELOCATE_UNVERIFIABLE} from ${lockPath}: cannot read lock mtime for recycled-pid reclaim: ${describeErrorIdentity(error)}`,
    );
  }
  const identity = await classifyRecycledPidIdentity(holder.pid, lockMtimeMs);
  if (identity.kind === "absent") return "not-recycled";
  if (identity.kind === "unconfirmable") {
    const detail = identity.reason === "same-second"
      ? `live pid ${holder.pid} start second equals lock mtime second (ps lstart is whole-second only; identity unconfirmable)`
      : `cannot confirm whether live pid ${holder.pid} is the original lock holder (process start time unreadable)`;
    throw new Error(`${BOARD_BOUND_RELOCATE_UNVERIFIABLE} from ${lockPath}: ${detail}`);
  }
  if (identity.kind !== "recycled") return "not-recycled";
  // Re-read before unlink: a real writer that replaced the orphan must not
  // lose its lock (same narrow window discipline as stale reclaim).
  const again = await autopsyWriterLock(lockPath);
  if (again.verdict !== "alive" || again.pid !== holder.pid) {
    return "not-recycled";
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return "reclaimed";
    throw error;
  }
  return "reclaimed";
}

async function describeHeldLeaseContest(lockPath: string): Promise<string> {
  const holder = await autopsyWriterLock(lockPath);
  if (holder.verdict === "alive") return `live pid ${holder.pid}`;
  if (holder.verdict === "dead") return `dead pid ${holder.pid}`;
  if (holder.verdict === "absent") return "absent holder";
  return holder.reason === "unreadable"
    ? `unreadable: ${describeErrorIdentity(holder.readFailure)}`
    : `unparseable holder: ${JSON.stringify(holder.content)}`;
}

async function acquireOneMutationClosureLease(
  runDirectory: string,
  onCleanupFailure: MutationClosureLeaseCleanupDiagnostic,
): Promise<RunWriterLease> {
  try {
    return await acquireRunWriterLease(runDirectory, onCleanupFailure);
  } catch (error) {
    if (!(error instanceof RunWriterLeaseHeldError)) throw error;
  }
  const lockPath = join(runDirectory, "writer.lock");
  const reclaimed = await reclaimRecycledMutationClosureLock(lockPath);
  if (reclaimed !== "reclaimed") {
    throw new Error(
      `${BOARD_BOUND_RELOCATE_REFUSE}:\n${lockPath} (${await describeHeldLeaseContest(lockPath)})`,
    );
  }
  try {
    return await acquireRunWriterLease(runDirectory, onCleanupFailure);
  } catch (error) {
    if (error instanceof RunWriterLeaseHeldError) {
      throw new Error(
        `${BOARD_BOUND_RELOCATE_REFUSE}:\n${lockPath} (${await describeHeldLeaseContest(lockPath)})`,
      );
    }
    throw error;
  }
}

/**
 * Freeze-time mutual exclusion for #863/#986 relocate: after the read-only
 * mutation-closure snapshot, take the ordinary writer lease on every run in
 * that frozen set and hold through rewrite/rename. Reuses acquire/release
 * without changing their semantics; recycled orphans are cleared only at this
 * gate. Caller must release every returned lease (including on apply failure).
 */
export async function holdBoardBoundUnboundRelocateClosure(
  booksDirectory: string,
  mutationClosureRunDirectories: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  onCleanupFailure: MutationClosureLeaseCleanupDiagnostic = defaultMutationClosureCleanupDiagnostic,
): Promise<readonly RunWriterLease[]> {
  await assertBoardBoundUnboundRelocatePrerequisites(
    booksDirectory,
    mutationClosureRunDirectories,
    env,
  );
  if (mutationClosureRunDirectories.length === 0) return [];

  // Sink is closed into each lease at acquire; normal finally release and
  // partial-acquire rollback release both surface cleanup failures there.
  const leases: RunWriterLease[] = [];
  try {
    for (const runDirectory of mutationClosureRunDirectories) {
      leases.push(
        await acquireOneMutationClosureLease(runDirectory, onCleanupFailure),
      );
    }
    return leases;
  } catch (error) {
    for (const lease of leases) {
      await lease.release();
    }
    throw error;
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

  const context: BookTopologyMigrationContext = {
    backupBooksDirectory,
    booksDirectory,
  };
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
