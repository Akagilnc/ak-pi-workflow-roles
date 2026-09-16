/**
 * Sitian whole-file volume I/O (ADR 0065 records-owner / record-entry).
 *
 * Owns destination resolution, create, raw read, and whole-file rewrite for
 * kinds whose persistence shape is not the appender SitianRecord row
 * (ticket-provenance header + bare dialogue lines, #901). Appender kernel
 * stays append-only; this module does not restore append watermarks.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, readlink, rename, symlink, unlink } from "node:fs/promises";

import {
  ensureRealDirectoryTree,
  errorText,
} from "./activation-ledger-topology.ts";
import { writeFileAtomically } from "./atomic-write.ts";
import { resolveSitianRecordPath } from "./sitian-appender.ts";
import {
  SitianInfrastructureError,
  type SitianRecordInput,
} from "./sitian-contracts.ts";

export type SitianVolumePath = {
  readonly recordFile: string;
  readonly volumeDir: string;
};

/** Resolve a volume path from ambient topology — callers never pick the destination. */
export function resolveSitianVolume(input: SitianRecordInput): SitianVolumePath {
  const path = resolveSitianRecordPath(input);
  return { recordFile: path.recordFile, volumeDir: path.sessionDir };
}

/**
 * Ensure the volume directory + file exist.
 * Append-open creates an absent volume without truncating concurrent first writers.
 */
export function ensureSitianVolume(input: SitianRecordInput): SitianVolumePath {
  try {
    const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
    ensureRealDirectoryTree(ledgerHome, sessionDir);
    appendFileSync(recordFile, "", "utf8");
    return { recordFile, volumeDir: sessionDir };
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian volume ensure failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}

/** Raw volume text. Absent file → text undefined (not an error). */
export async function readSitianVolumeText(
  input: SitianRecordInput,
): Promise<{ readonly recordFile: string; readonly text: string | undefined }> {
  const { recordFile } = resolveSitianVolume(input);
  try {
    return { recordFile, text: await readFile(recordFile, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { recordFile, text: undefined };
    }
    throw new SitianInfrastructureError(
      `Sitian volume read failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize one volume's read→merge→publish transaction across processes.
 * The lock is scoped to the resolved volume, and a dead holder is reclaimed.
 */
export async function withSitianVolumeTransaction<T>(
  input: SitianRecordInput,
  transaction: () => Promise<T>,
): Promise<T> {
  const volume = ensureSitianVolume(input);
  const lockPath = `${volume.recordFile}.lock`;
  const recoveryPath = `${lockPath}.recover`;
  while (true) {
    // A stale-claim mover blocks new contenders before touching lockPath.
    try {
      const recoveryHolder = Number.parseInt(await readlink(recoveryPath), 10);
      try {
        process.kill(recoveryHolder, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          throw new SitianInfrastructureError(
            `Sitian volume recovery holder died: ${recoveryPath}`,
          );
        }
        throw error;
      }
      await sleep(15);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const nonce = randomUUID();
    const ownClaim = `${process.pid}:${nonce}`;
    let acquired = false;
    try {
      // Owner identity and exclusion appear in one atomic filesystem operation.
      await symlink(ownClaim, lockPath);
      acquired = true;
      try {
        return await transaction();
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (acquired || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let staleClaim: string;
      try {
        staleClaim = await readlink(lockPath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      const [pidText, staleNonce] = staleClaim.split(":");
      const holder = Number.parseInt(pidText ?? "", 10);
      if (!Number.isSafeInteger(holder) || holder <= 0 || !staleNonce) {
        throw new SitianInfrastructureError(
          `Sitian volume transaction lock has no verifiable holder: ${lockPath}`,
        );
      }
      try {
        process.kill(holder, 0);
        await sleep(15);
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") throw signalError;
        try {
          await symlink(String(process.pid), recoveryPath);
          try {
            // Revalidate under the recovery claim. A slipped successor is never moved.
            if ((await readlink(lockPath).catch(() => undefined)) === staleClaim) {
              await rename(lockPath, `${lockPath}.stale-${staleNonce}`);
            }
          } finally {
            await unlink(recoveryPath).catch(() => undefined);
          }
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "EEXIST") throw recoveryError;
          await sleep(15);
        }
      }
    }
  }
}

/**
 * Replace the entire volume body (whole-file reproject).
 * Same-directory temp + rename — never truncate the live inode in place
 * (#901 sole diary; reuse atomic-write, no parallel persist mechanism).
 * Not append; no identity claim / torn-tail watermark — those stay on appender.
 */
export async function rewriteSitianVolume(
  input: SitianRecordInput & { readonly body: string },
): Promise<SitianVolumePath> {
  try {
    const volume = ensureSitianVolume(input);
    await writeFileAtomically(volume.recordFile, input.body);
    return volume;
  } catch (error) {
    if (error instanceof SitianInfrastructureError) throw error;
    throw new SitianInfrastructureError(
      `Sitian volume rewrite failure: ${errorText(error)}`,
      { cause: error },
    );
  }
}
