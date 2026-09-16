/**
 * Sitian whole-file volume I/O (ADR 0065 records-owner / record-entry).
 *
 * Owns destination resolution, create, raw read, and whole-file rewrite for
 * kinds whose persistence shape is not the appender SitianRecord row
 * (ticket-provenance header + bare dialogue lines, #901). Appender kernel
 * stays append-only; this module does not restore append watermarks.
 */
import { appendFileSync } from "node:fs";
import { lstat, readFile, readlink, unlink } from "node:fs/promises";
import lockfile from "proper-lockfile";

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

async function legacyClaimIsLive(path: string): Promise<boolean | undefined> {
  let claim: string;
  try {
    claim = await readlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EINVAL") return false;
    throw error;
  }
  const holder = Number.parseInt(claim.split(":", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(holder) || holder <= 0) return false;
  try {
    process.kill(holder, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function unlinkLegacyResidue(
  path: string,
  allowLeaseDirectory: boolean,
): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (allowLeaseDirectory && (code === "EISDIR" || code === "EPERM")) {
      const current = await lstat(path).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code === "ENOENT") return undefined;
        throw statError;
      });
      if (current === undefined || current.isDirectory()) return;
    }
    throw error;
  }
}

/**
 * Serialize one volume's read→merge→publish transaction across processes.
 * proper-lockfile owns one mkdir lease with heartbeat and stale takeover; OS
 * death at any point therefore needs no second recovery lock or owner publish.
 */
export async function withSitianVolumeTransaction<T>(
  input: SitianRecordInput,
  transaction: () => Promise<T>,
): Promise<T> {
  const { recordFile } = ensureSitianVolume(input);
  const lockPath = `${recordFile}.lock`;
  const legacyRecoveryPath = `${lockPath}.recover`;

  // One-way startup migration: old executables are not a supported concurrent
  // protocol. Retire only the crash residue they left before this process
  // enters the sole lease protocol; later claims are directories, never links.
  const legacyRecovery = await legacyClaimIsLive(legacyRecoveryPath);
  if (legacyRecovery === true) {
    throw new SitianInfrastructureError(
      `legacy Sitian volume recovery is still active: ${legacyRecoveryPath}`,
    );
  }
  if (legacyRecovery === false) await unlinkLegacyResidue(legacyRecoveryPath, false);
  const legacyClaim = await legacyClaimIsLive(lockPath);
  if (legacyClaim === true) {
    throw new SitianInfrastructureError(`legacy Sitian volume transaction is still active: ${lockPath}`);
  }
  if (legacyClaim === false) await unlinkLegacyResidue(lockPath, true);

  while (true) {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(recordFile, {
        lockfilePath: lockPath,
        realpath: false,
        stale: 2_000,
        update: 1_000,
        retries: 0,
      });
      return await transaction();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      await sleep(15);
    } finally {
      await release?.();
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
