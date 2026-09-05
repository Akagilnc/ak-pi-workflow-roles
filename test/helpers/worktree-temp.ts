/**
 * #685 / owner 2026-09-06: test fixtures may only delete directories inside this
 * worktree. Temp roots live under `<package>/.test-tmp/` so create-and-delete
 * stays lawful; #612 no-residue applies to these worktree-internal roots.
 * System tmpdir / real home paths must not be deleted by tests/helpers.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const worktreePackageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

/** Worktree-internal fixture root (gitignored). */
export const WORKTREE_TEST_TMP = join(worktreePackageRoot, ".test-tmp");

function ensureWorktreeTestTmp(): string {
  mkdirSync(WORKTREE_TEST_TMP, { recursive: true });
  return WORKTREE_TEST_TMP;
}

/** Drop-in replacement for os.tmpdir() when creating test fixture roots. */
export function testTmpdir(): string {
  return ensureWorktreeTestTmp();
}

/** Synchronous mkdtemp under the worktree fixture root. */
export function mkWorktreeTempSync(prefix: string): string {
  return mkdtempSync(join(ensureWorktreeTestTmp(), prefix));
}

/** Async mkdtemp under the worktree fixture root. */
export async function mkWorktreeTemp(prefix: string): Promise<string> {
  ensureWorktreeTestTmp();
  return mkdtemp(join(WORKTREE_TEST_TMP, prefix));
}

/** True when `target` resolves inside this package worktree. */
export function isInsideWorktree(target: string): boolean {
  const resolved = resolve(target);
  const root = resolve(worktreePackageRoot);
  return resolved === root || resolved.startsWith(root + sep);
}

/** Delete a directory only when it sits inside this worktree. */
export async function rmWorktreeDir(target: string): Promise<void> {
  if (!isInsideWorktree(target)) return;
  await rm(target, { recursive: true, force: true });
}

/** Sync counterpart of {@link rmWorktreeDir}. */
export function rmWorktreeDirSync(target: string): void {
  if (!isInsideWorktree(target)) return;
  rmSync(target, { recursive: true, force: true });
}
