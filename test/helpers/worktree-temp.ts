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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
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

function isInsideWorktree(path: string): boolean {
  const wt = worktreePackageRoot;
  return path === wt || path.startsWith(`${wt}/`) || path.startsWith(`${wt}\\`);
}

function hasNodeModulesInAncestry(start: string): boolean {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "node_modules"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export type OutsideWorktreeTempOptions = {
  /**
   * Prefer a base whose ancestor chain has no node_modules (ESM package lookup).
   * macOS os.tmpdir() often sits under a user folder that already carries one.
   */
  isolateNodeAncestors?: boolean;
};

/**
 * mkdtemp prefix outside this worktree for true Git / Node-ancestor isolation.
 * Uses os.tmpdir(); if that lands inside this worktree (worktree-local TMPDIR),
 * or (when requested) under a node_modules ancestry, falls back to a conventional
 * system temp root so the fixture stays outside. Create-and-abandon — do not
 * delete the resulting root (worktree-only restore).
 */
export function outsideWorktreeTempPrefix(
  label: string,
  options: OutsideWorktreeTempOptions = {},
): string {
  const bases = [tmpdir()];
  if (process.platform !== "win32") {
    for (const fallback of ["/tmp", "/var/tmp"]) {
      if (!bases.includes(fallback)) bases.push(fallback);
    }
  }
  for (const base of bases) {
    if (isInsideWorktree(base)) continue;
    if (options.isolateNodeAncestors && hasNodeModulesInAncestry(base)) continue;
    return join(base, label);
  }
  return join(tmpdir(), label);
}
