import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BOOK_TOPOLOGY_MIGRATION_LOCK = "book-topology-migration.lock";
export const BOOK_TOPOLOGY_ADMISSION_LOCK = ".admission-in-progress";

export function bookTopologyMigrationLockPath(ledgerHome: string): string {
  return join(ledgerHome, BOOK_TOPOLOGY_MIGRATION_LOCK);
}

/**
 * Admission half of the migration interlock. The per-run claim remains until
 * run-state.json is durable, closing the scan→rename race with migration.
 */
export function claimBookTopologyAdmission(ledgerHome: string, runDirectory: string): void {
  const migrationLock = bookTopologyMigrationLockPath(ledgerHome);
  const claim = join(runDirectory, BOOK_TOPOLOGY_ADMISSION_LOCK);
  try {
    closeSync(openSync(migrationLock, "wx"));
    unlinkSync(migrationLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`role admission blocked by book topology migration: ${migrationLock}`);
  }

  writeFileSync(claim, `${process.pid}\n`, { flag: "wx" });
  try {
    closeSync(openSync(migrationLock, "wx"));
    unlinkSync(migrationLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    unlinkSync(claim);
    throw new Error(`role admission blocked by book topology migration: ${migrationLock}`);
  }
}

export function settleBookTopologyAdmission(runDirectory: string): void {
  try {
    unlinkSync(join(runDirectory, BOOK_TOPOLOGY_ADMISSION_LOCK));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
