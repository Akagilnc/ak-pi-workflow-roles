/**
 * #604: production CLI ignores process.env.HOME (passwd/user-profile home only).
 * Real-bin package tests therefore write seat config + ledger under the machine
 * home. This guard uses a cross-process lock, durable on-disk backup, saves/restores
 * public-cli.json and removes test-owned book directories so the host ledger is
 * not left dirty.
 *
 * Crash contract: backup file is the recovery source. On entry under the lock,
 * any leftover backup from a killed prior holder is restored before a new backup
 * is taken — never overwrite a surviving backup with a blanked table.
 */
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  /** When true (default), blanks seats for cold-surface testing. */
  readonly blankSeats?: boolean;
};

function lockHolderAlive(pidText: string): boolean {
  const pid = Number.parseInt(pidText.trim().split(/\r?\n/, 1)[0] ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireCrossProcessLock(
  lockPath: string,
  timeoutMs = 60_000,
  retryIntervalMs = 50,
): Promise<() => Promise<void>> {
  const start = Date.now();
  let handle: FileHandle | undefined;
  while (true) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Dead holder left the lock behind — clear and retry once the pid is gone.
      try {
        const holder = await readFile(lockPath, "utf8");
        if (!lockHolderAlive(holder)) {
          await rm(lockPath, { force: true });
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
  return async () => {
    try {
      await handle?.close();
    } catch {
      // best-effort close before unlinking
    }
    await rm(lockPath, { force: true });
  };
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
    // Restore it before taking a new backup so a blanked table cannot become "prior".
    const staleBackup = await readOptionalUtf8(backupPath);
    if (staleBackup !== undefined) {
      await writeFile(configPath, staleBackup, "utf8");
    }

    const priorConfig = await readOptionalUtf8(configPath);
    if (priorConfig !== undefined) {
      await writeFile(backupPath, priorConfig, "utf8");
      restoreFromBackup = true;
    } else {
      await rm(backupPath, { force: true });
    }

    if (options.blankSeats !== false) {
      await writeFile(configPath, `${JSON.stringify({ seats: {} }, null, 2)}\n`, "utf8");
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
          await writeFile(configPath, backupBytes, "utf8");
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
