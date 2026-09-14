/**
 * Sitian whole-file volume I/O (ADR 0065 records-owner / record-entry).
 *
 * Owns destination resolution, create, raw read, and whole-file rewrite for
 * kinds whose persistence shape is not the appender SitianRecord row
 * (ticket-provenance header + bare dialogue lines, #901). Appender kernel
 * stays append-only; this module does not restore append watermarks.
 */
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

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
