/**
 * Platform kernel-atomic create-if-absent rename (directories and files).
 *
 * Ownership of the entire source tree transfers in one operation, or the call
 * fails without altering the destination name. Empty directories, files, and
 * symlinks at the destination all count as occupied.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type RenameBinding = {
  renameNoReplace(from: string, to: string): void;
};

const require = createRequire(import.meta.url);

let cached: RenameBinding | null = null;

function resolveBindingPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Compiled output sibling (production dist/recorder).
    join(here, "rename_no_replace.node"),
    // tsx execution from src/recorder → dist/recorder.
    join(here, "..", "..", "dist", "recorder", "rename_no_replace.node"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "rename_no_replace.node binding missing; run npm run build:recorder",
  );
}

function loadBinding(): RenameBinding {
  if (cached) return cached;
  const path = resolveBindingPath();
  cached = require(path) as RenameBinding;
  return cached;
}

export type RenameNoReplaceError = Error & {
  code?: string;
  errno?: number;
};

export function isOccupiedRenameError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code =
    "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "EISDIR" ||
    code === "ENOTDIR"
  );
}

/** Atomically rename `from` to `to` only if `to` does not exist. */
export function renameNoReplace(from: string, to: string): void {
  loadBinding().renameNoReplace(from, to);
}
