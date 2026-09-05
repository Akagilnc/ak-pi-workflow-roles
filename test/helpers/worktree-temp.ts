/**
 * #685 / owner 2026-09-06: fixture roots that tests create and delete must live
 * inside this worktree. Outside the worktree (real home, system tmpdir, other
 * paths) must not be deleted. #612: tests restore the worktree to its pre-run
 * state by deleting the self-created roots they own.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const worktreePackageRoot = dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

/** Worktree-local fixture parent (gitignored). Callers create children and delete them. */
export const WORKTREE_TEST_TMP = join(worktreePackageRoot, ".test-tmp");

/** Drop-in for os.tmpdir() when creating self-owned fixture roots under this worktree. */
export function testTmpdir(): string {
  mkdirSync(WORKTREE_TEST_TMP, { recursive: true });
  return WORKTREE_TEST_TMP;
}
