/**
 * #604: production CLI ignores process.env.HOME (passwd/user-profile home only).
 * Real-bin package tests therefore write seat config + ledger under the machine
 * home. This guard uses a cross-process lock, durable on-disk backup, saves/restores
 * public-cli.json and removes test-owned book directories so the host ledger is
 * not left dirty.
 *
 * Crash contract:
 * - Lock owner metadata is complete before the lock name is visible (temp + link).
 * - Release verifies ownership payload (no blind rm).
 * - Stale recovery uses rename-aside (single winner); payload mismatch restores the
 *   moved lock so a competing reclaimer cannot delete a new owner's lock (no TOCTOU unlink).
 * - Backup encodes prior presence OR absence; crash mid-flight cannot promote a
 *   blanked/mutated table to "prior".
 * - Backup and config restore write via temp file + rename — never truncate in place.
 * - Do not blank the host seat table on entry; callers mutate only the keys they need.
 * - Leftover backup from a killed prior holder is restored before a new backup is taken.
 */
import { randomBytes } from "node:crypto";
import { access, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  packageMachineHome,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";

export type PackageMachineHomeGuard = {
  /** Passwd/user-profile home the production binary actually uses. */
  readonly packageHome: string;
  /** `packageHome/.ak-roles`. */
  readonly ledgerHome: string;
  /** Seat config path under the machine home. */
  readonly configPath: string;
  /** Register a book key created by this test for cleanup. */
  trackBook(bookKey: string): void;
};

export type PackageMachineHomeGuardOptions = {
  /**
   * When true, blanks seats for an explicit cold-surface scenario.
   * Default false: do not wipe the host table; mutate only needed keys.
   */
  readonly blankSeats?: boolean;
  /**
   * Test-only override of the package home root. Default: real packageMachineHome().
   * Lets absence/presence backup proofs run without mutating the host seat table.
   */
  readonly packageHome?: string;
};

/** Backup wire format: first line is presence tag; body follows only when present. */
const BACKUP_ABSENT = "A\n";
const BACKUP_PRESENT_TAG = "P\n";

function lockPayload(): string {
  return `${process.pid}\n${Date.now()}\n${randomBytes(8).toString("hex")}\n`;
}

function parseLockPid(text: string): number | undefined {
  const pid = Number.parseInt(text.trim().split(/\r?\n/, 1)[0] ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  return pid;
}

function lockHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteUtf8(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, contents, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Publish lock name only after full owner metadata is on disk (temp + link).
 * Stale recovery: rename-aside so exactly one reclaimer wins; verify payload and
 * restore on mismatch so a new owner's lock is never deleted by a lagging reclaimer.
 */
async function acquireCrossProcessLock(
  lockPath: string,
  timeoutMs = 60_000,
  retryIntervalMs = 50,
): Promise<() => Promise<void>> {
  const myPayload = lockPayload();
  const start = Date.now();
  while (true) {
    const tmp = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, myPayload, "utf8");
    try {
      await link(tmp, lockPath);
      await rm(tmp, { force: true });
      return async () => {
        try {
          const current = await readFile(lockPath, "utf8");
          if (current !== myPayload) return; // not our lock — do not delete
          await rm(lockPath, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const holder = await readFile(lockPath, "utf8");
        const pid = parseLockPid(holder);
        const stale = pid === undefined ? true : !lockHolderAlive(pid);
        if (stale) {
          // Single-winner reclaim: rename moves the inode aside atomically.
          // A second reaper gets ENOENT and retries; it never unlinks a successor lock.
          const reclaimPath = `${lockPath}.reclaim.${process.pid}.${randomBytes(6).toString("hex")}`;
          try {
            await rename(lockPath, reclaimPath);
          } catch (reclaimError) {
            if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") {
              // Other reclaimer already took it.
              continue;
            }
            throw reclaimError;
          }
          let moved: string;
          try {
            moved = await readFile(reclaimPath, "utf8");
          } catch {
            await rm(reclaimPath, { force: true }).catch(() => undefined);
            continue;
          }
          await rm(reclaimPath, { force: true }).catch(() => undefined);
          if (moved !== holder) {
            // Renamed a lock that was not the stale payload we inspected — put it back.
            const restoreTmp = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.restore`;
            await writeFile(restoreTmp, moved, "utf8");
            try {
              await link(restoreTmp, lockPath);
            } catch (restoreError) {
              // Successor already published a new lock; drop the stray copy.
              if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") {
                await rm(restoreTmp, { force: true }).catch(() => undefined);
                throw restoreError;
              }
            }
            await rm(restoreTmp, { force: true }).catch(() => undefined);
            continue;
          }
          // Stale lock removed; retry acquire.
          continue;
        }
      } catch {
        // raced with holder release or unreadable lock; fall through to retry
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for lock at ${lockPath} after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
    }
  }
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type BackupState =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly bytes: string };

function encodeBackup(state: BackupState): string {
  return state.kind === "absent" ? BACKUP_ABSENT : `${BACKUP_PRESENT_TAG}${state.bytes}`;
}

function decodeBackup(raw: string): BackupState | undefined {
  if (raw === BACKUP_ABSENT || raw === "A") return { kind: "absent" };
  if (raw.startsWith(BACKUP_PRESENT_TAG)) {
    return { kind: "present", bytes: raw.slice(BACKUP_PRESENT_TAG.length) };
  }
  // Legacy bare-config backup (pre-absence encoding): treat whole file as present body.
  if (raw.length > 0) return { kind: "present", bytes: raw };
  return undefined;
}

async function applyBackupState(configPath: string, state: BackupState): Promise<void> {
  if (state.kind === "absent") {
    await rm(configPath, { force: true });
    return;
  }
  await atomicWriteUtf8(configPath, state.bytes);
}

export async function withPackageMachineHomeGuard<T>(
  optionsOrScenario:
    | PackageMachineHomeGuardOptions
    | ((guard: PackageMachineHomeGuard) => Promise<T>),
  scenarioMaybe?: (guard: PackageMachineHomeGuard) => Promise<T>,
): Promise<T> {
  const options: PackageMachineHomeGuardOptions =
    typeof optionsOrScenario === "function" ? {} : optionsOrScenario;
  const scenario =
    typeof optionsOrScenario === "function"
      ? optionsOrScenario
      : scenarioMaybe!;

  const packageHome =
    typeof options.packageHome === "string" && options.packageHome.length > 0
      ? options.packageHome
      : packageMachineHome();
  const ledgerHome = resolveActivationLedgerHome(packageHome);
  const dotAkRoles = join(packageHome, ".ak-roles");
  await mkdir(dotAkRoles, { recursive: true });

  const configPath = join(dotAkRoles, "public-cli.json");
  const lockPath = join(dotAkRoles, "public-cli.json.ak-roles-test.lock");
  const backupPath = join(dotAkRoles, "public-cli.json.ak-roles-test-backup");

  const releaseLock = await acquireCrossProcessLock(lockPath);
  const trackedBooks = new Set<string>();
  let backupState: BackupState | undefined;

  try {
    // Crash recovery: leftover backup is the last known-good host table (or absence).
    // Restore it before taking a new backup so a blanked/mutated table cannot become "prior".
    const staleBackupRaw = await readOptionalUtf8(backupPath);
    if (staleBackupRaw !== undefined) {
      const staleState = decodeBackup(staleBackupRaw);
      if (staleState !== undefined) {
        await applyBackupState(configPath, staleState);
      }
    }

    const priorConfig = await readOptionalUtf8(configPath);
    backupState =
      priorConfig === undefined
        ? { kind: "absent" }
        : { kind: "present", bytes: priorConfig };
    await atomicWriteUtf8(backupPath, encodeBackup(backupState));

    // Default: leave host seats intact. Only blank when a scenario opts in.
    if (options.blankSeats === true) {
      await atomicWriteUtf8(configPath, `${JSON.stringify({ seats: {} }, null, 2)}\n`);
    }

    const guard: PackageMachineHomeGuard = {
      packageHome,
      ledgerHome,
      configPath,
      trackBook(bookKey: string) {
        trackedBooks.add(bookKey);
      },
    };

    return await scenario(guard);
  } finally {
    try {
      for (const bookKey of trackedBooks) {
        await rm(join(ledgerHome, "books", bookKey), { recursive: true, force: true });
      }
      if (backupState !== undefined) {
        // Prefer on-disk backup (survives mid-flight crash of a prior holder) over memory.
        const diskRaw = await readOptionalUtf8(backupPath);
        const state =
          diskRaw !== undefined ? (decodeBackup(diskRaw) ?? backupState) : backupState;
        await applyBackupState(configPath, state);
        await rm(backupPath, { force: true });
      }
    } finally {
      await releaseLock();
    }
  }
}

/** Read-only probe: true when path exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
