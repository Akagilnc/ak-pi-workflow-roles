/**
 * #604: production CLI ignores process.env.HOME (passwd/user-profile home only).
 * Real-bin package tests therefore write seat config + ledger under the machine
 * home. This guard uses a cross-process lock, durable on-disk backup, saves/restores
 * public-cli.json and removes test-owned book directories so the host ledger is
 * not left dirty.
 *
 * Crash contract:
 * - Lock owner metadata is complete before the lock name is visible (temp + link).
 * - Release and stale recovery verify ownership / unchanged payload (no blind rm).
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
};

function lockPayload(): string {
  return `${process.pid}\n${Date.now()}\n`;
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
      // Lock name becomes visible only after full owner metadata is linked in.
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
      // Stale recovery: only remove when payload is unchanged and holder is dead
      // (or unparseable leftover from a pre-atomic protocol).
      try {
        const holder = await readFile(lockPath, "utf8");
        const pid = parseLockPid(holder);
        const stale =
          pid === undefined ? true : !lockHolderAlive(pid);
        if (stale) {
          const again = await readFile(lockPath, "utf8").catch(() => undefined);
          if (again === holder) {
            await rm(lockPath, { force: true });
            continue;
          }
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

  const packageHome = packageMachineHome();
  const ledgerHome = resolveActivationLedgerHome(packageHome);
  const dotAkRoles = join(packageHome, ".ak-roles");
  await mkdir(dotAkRoles, { recursive: true });

  const configPath = join(dotAkRoles, "public-cli.json");
  const lockPath = join(dotAkRoles, "public-cli.json.ak-roles-test.lock");
  const backupPath = join(dotAkRoles, "public-cli.json.ak-roles-test-backup");

  const releaseLock = await acquireCrossProcessLock(lockPath);
  const trackedBooks = new Set<string>();
  /** True when a host config existed (or was recovered) and must be restored. */
  let restoreFromBackup = false;

  try {
    // Crash recovery: leftover backup is the last known-good host table.
    // Restore it before taking a new backup so a blanked/mutated table cannot become "prior".
    const staleBackup = await readOptionalUtf8(backupPath);
    if (staleBackup !== undefined) {
      await atomicWriteUtf8(configPath, staleBackup);
    }

    const priorConfig = await readOptionalUtf8(configPath);
    if (priorConfig !== undefined) {
      await atomicWriteUtf8(backupPath, priorConfig);
      restoreFromBackup = true;
    } else {
      await rm(backupPath, { force: true });
    }

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
      if (restoreFromBackup) {
        const backupBytes = await readOptionalUtf8(backupPath);
        if (backupBytes === undefined) {
          // Backup missing mid-flight: leave configPath as-is rather than delete host seats.
        } else {
          await atomicWriteUtf8(configPath, backupBytes);
          await rm(backupPath, { force: true });
        }
      } else {
        await rm(configPath, { force: true });
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
