/**
 * #604: production CLI ignores process.env.HOME (passwd/user-profile home only).
 * Real-bin package tests therefore write seat config + ledger under the machine
 * home. This guard saves/restores public-cli.json and removes test-owned book
 * directories so the host ledger is not left dirty.
 */
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

export async function withPackageMachineHomeGuard<T>(
  scenario: (guard: PackageMachineHomeGuard) => Promise<T>,
): Promise<T> {
  const packageHome = packageMachineHome();
  const ledgerHome = resolveActivationLedgerHome(() => packageHome);
  const configPath = join(packageHome, ".ak-roles", "public-cli.json");
  const trackedBooks = new Set<string>();

  let priorConfig: string | undefined;
  let priorConfigExisted = false;
  try {
    priorConfig = await readFile(configPath, "utf8");
    priorConfigExisted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Start from a blank seat table so the real binary sees the same unconfigured
  // surface the old HOME-isolated tests did — then restore the host file on exit.
  await mkdir(join(packageHome, ".ak-roles"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ seats: {} }, null, 2)}\n`, "utf8");

  const guard: PackageMachineHomeGuard = {
    packageHome,
    ledgerHome,
    configPath,
    trackBook(bookKey: string) {
      trackedBooks.add(bookKey);
    },
  };

  try {
    return await scenario(guard);
  } finally {
    for (const bookKey of trackedBooks) {
      await rm(join(ledgerHome, "books", bookKey), { recursive: true, force: true });
    }
    if (priorConfigExisted && priorConfig !== undefined) {
      await mkdir(join(packageHome, ".ak-roles"), { recursive: true });
      await writeFile(configPath, priorConfig, "utf8");
    } else {
      await rm(configPath, { force: true });
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
