/**
 * #685 / owner 2026-09-06: fixture roots that tests create and delete must live
 * inside this worktree. Outside the worktree (real home, system tmpdir, other
 * paths) must not be deleted. #612: tests restore the worktree to its pre-run
 * state by deleting the self-created roots they own.
 *
 * No shared parent directory: each mkdtemp(worktreeTempPrefix(label)) yields a
 * sibling root under the worktree. The creating seam owns create→use→cleanup;
 * parallel test processes cannot clobber a common parent, and no process tries
 * to rmdir a parent it did not solely own.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const worktreePackageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

/**
 * mkdtemp prefix under this worktree. Result path is
 * `<worktree>/.test-tmp-<label>XXXXXX` after mkdtemp — self-owned, gitignored.
 */
export function worktreeTempPrefix(label: string): string {
  const normalized = label.startsWith(".test-tmp-") ? label : `.test-tmp-${label}`;
  return join(worktreePackageRoot, normalized);
}

/**
 * @deprecated Prefer worktreeTempPrefix(label) so each fixture is a self-owned
 * sibling root. Kept only for call sites that need the package root path itself.
 */
export function testTmpdir(): string {
  return worktreePackageRoot;
}

/** @deprecated No shared parent; use worktreeTempPrefix. */
export const WORKTREE_TEST_TMP = join(worktreePackageRoot, ".test-tmp");
