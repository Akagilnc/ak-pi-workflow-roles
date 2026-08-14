/**
 * Same-directory temp + rename atomic file replace.
 * Shared primitive for ledger-adjacent typed pages (taishi metrics, etc.).
 * Does not open/truncate an existing destination inode, so hard-linked twins
 * keep prior bytes until the directory entry is swapped.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFileAtomically(
  destination: string,
  contents: string | Uint8Array,
): Promise<void> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.atomic-write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
