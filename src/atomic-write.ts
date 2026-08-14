/**
 * Same-directory temp + rename atomic file replace.
 * Shared primitive for ledger-adjacent typed pages (taishi metrics, etc.).
 * Does not open/truncate an existing destination inode, so hard-linked twins
 * keep prior bytes until the directory entry is swapped.
 * Parent directory must already exist — callers that write under the package
 * ledger home own confinement via ensureRealDirectoryTree (ADR 0038).
 */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFileAtomically(
  destination: string,
  contents: string | Uint8Array,
): Promise<void> {
  const parent = dirname(destination);
  const temporary = join(parent, `.atomic-write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
