/**
 * #685 / owner 2026-09-06: test fixtures may only delete directories they
 * created under this worktree's `.test-tmp/`. System tmpdir / real home / any
 * other worktree path (including package source) must not be deleted here.
 * #612 no-residue applies only to these self-created `.test-tmp` roots.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const worktreePackageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

/** Sole lawful fixture root for create-and-delete (gitignored). */
export const WORKTREE_TEST_TMP = join(worktreePackageRoot, ".test-tmp");

function ensureWorktreeTestTmp(): string {
  mkdirSync(WORKTREE_TEST_TMP, { recursive: true });
  return WORKTREE_TEST_TMP;
}

/** Drop-in for os.tmpdir() when creating self-owned fixture roots. */
export function testTmpdir(): string {
  return ensureWorktreeTestTmp();
}

export function mkWorktreeTempSync(prefix: string): string {
  return mkdtempSync(join(ensureWorktreeTestTmp(), prefix));
}

export async function mkWorktreeTemp(prefix: string): Promise<string> {
  ensureWorktreeTestTmp();
  return mkdtemp(join(WORKTREE_TEST_TMP, prefix));
}

/**
 * True only for paths strictly under `.test-tmp/` (not the worktree root,
 * not package source, not system tmpdir).
 */
export function isSelfCreatedTestTemp(target: string): boolean {
  const resolved = resolve(target);
  const base = resolve(WORKTREE_TEST_TMP);
  return resolved.startsWith(base + sep);
}

function assertSelfCreatedTestTemp(target: string): string {
  const resolved = resolve(target);
  if (!isSelfCreatedTestTemp(resolved)) {
    throw new Error(
      `refusing to delete path outside self-created .test-tmp root: ${resolved} (allowed under ${resolve(WORKTREE_TEST_TMP)}${sep})`,
    );
  }
  return resolved;
}

/** Delete only a self-created directory under `.test-tmp/`. Other paths throw. */
export async function rmWorktreeDir(target: string): Promise<void> {
  const resolved = assertSelfCreatedTestTemp(target);
  await rm(resolved, { recursive: true, force: true });
}

/** Sync counterpart of {@link rmWorktreeDir}. */
export function rmWorktreeDirSync(target: string): void {
  const resolved = assertSelfCreatedTestTemp(target);
  rmSync(resolved, { recursive: true, force: true });
}
