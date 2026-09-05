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
export const WORKTREE_TEST_TMP = join(worktreePackageRoot, ".test-tmp");
function ensureWorktreeTestTmp(): string {
  mkdirSync(WORKTREE_TEST_TMP, { recursive: true });
  return WORKTREE_TEST_TMP;
}
export function testTmpdir(): string { return ensureWorktreeTestTmp(); }
export function mkWorktreeTempSync(prefix: string): string {
  return mkdtempSync(join(ensureWorktreeTestTmp(), prefix));
}
export async function mkWorktreeTemp(prefix: string): Promise<string> {
  ensureWorktreeTestTmp();
  return mkdtemp(join(WORKTREE_TEST_TMP, prefix));
}
export function isInsideWorktree(target: string): boolean {
  const resolved = resolve(target);
  const root = resolve(worktreePackageRoot);
  return resolved === root || resolved.startsWith(root + sep);
}
export async function rmWorktreeDir(target: string): Promise<void> {
  if (!isInsideWorktree(target)) return;
  await rm(target, { recursive: true, force: true });
}
export function rmWorktreeDirSync(target: string): void {
  if (!isInsideWorktree(target)) return;
  rmSync(target, { recursive: true, force: true });
}
