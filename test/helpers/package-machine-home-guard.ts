/**
 * #604: production CLI ignores process.env.HOME (passwd/user-profile home only).
 * Real-bin package tests therefore write seat config + ledger under the machine
 * home. This guard uses a cross-process lock, durable on-disk backup, saves/restores
 * public-cli.json and removes test-owned book directories so the host ledger is
 * not left dirty.
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out waiting for lock at ${lockPath} after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      } else {
        throw error;
      }
    }
  }
  return async () => {
    try {
      if (handle) {
        await handle.close();
      }
    } catch {}
    try {
      await rm(lockPath, { force: true });
    } catch {}
  };
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
  let priorConfigExisted = false;

  try {
    try {
      const priorConfig = await readFile(configPath, "utf8");
      priorConfigExisted = true;
      // Durable on-disk backup before any mutate
      await writeFile(backupPath, priorConfig, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // No config existed initially; ensure stale backup is cleared
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
      if (priorConfigExisted) {
        try {
          const backupBytes = await readFile(backupPath, "utf8");
          await writeFile(configPath, backupBytes, "utf8");
          await rm(backupPath, { force: true });
        } catch {
          // If backup read failed, preserve configPath
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
