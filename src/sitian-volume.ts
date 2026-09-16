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
import { mkdir, readFile, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

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
  const ownerFile = join(lockPath, "owner");
  while (true) {
    const nonce = randomUUID();
    let acquired = false;
    try {
      await mkdir(lockPath);
      acquired = true;
      try {
        await writeFileAtomically(ownerFile, `${process.pid}:${nonce}\n`);
        return await transaction();
      } finally {
        await unlink(ownerFile).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (acquired || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let claim: string;
      try {
        claim = (await readFile(ownerFile, "utf8")).trim();
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
          const recoveryPath = `${lockPath}.recover`;
          try {
            await symlink(String(process.pid), recoveryPath);
            try {
              // Give a live winner time to finish its atomic owner publication.
              await sleep(30);
              try {
                await readFile(ownerFile, "utf8");
              } catch (retryError) {
                if ((retryError as NodeJS.ErrnoException).code !== "ENOENT") throw retryError;
                await rename(lockPath, `${lockPath}.stale-unowned-${randomUUID()}`)
                  .catch((renameError) => {
                    if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
                  });
              }
            } finally {
              await unlink(recoveryPath).catch(() => undefined);
            }
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code !== "EEXIST") throw recoveryError;
            let recoveryHolder: number;
            try {
              recoveryHolder = Number.parseInt(await readlink(recoveryPath), 10);
            } catch (readRecoveryError) {
              if ((readRecoveryError as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw readRecoveryError;
            }
            try {
              process.kill(recoveryHolder, 0);
            } catch (signalError) {
              if ((signalError as NodeJS.ErrnoException).code === "ESRCH") {
                throw new SitianInfrastructureError(
                  `Sitian ownerless-lock recovery holder died: ${recoveryPath}`,
                );
              }
              throw signalError;
            }
            await sleep(15);
          }
          continue;
        }
        throw readError;
      }
      const [pidText, staleNonce] = claim.split(":");
      const holder = Number.parseInt(pidText ?? "", 10);
      if (!Number.isSafeInteger(holder) || holder <= 0 || !staleNonce) {
        throw new SitianInfrastructureError(
          `Sitian volume transaction lock has no verifiable holder: ${lockPath}`,
        );
      }
      try {
        process.kill(holder, 0);
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code === "ESRCH") {
          // The nonce-addressed nonempty tombstone is deliberately retained.
          // A second reclaimer of this claim cannot rename a successor lock over it.
          const tombstone = `${lockPath}.stale-${staleNonce}`;
          try {
            await rename(lockPath, tombstone);
          } catch (renameError) {
            const code = (renameError as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") {
              throw renameError;
            }
          }
          continue;
        }
        throw signalError;
      }
      await sleep(15);
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
