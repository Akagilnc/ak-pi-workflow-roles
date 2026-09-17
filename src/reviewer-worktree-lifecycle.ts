import { execFile } from "node:child_process";
import { access, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OWNERSHIP_FILE = "reviewer-worktree-ownership.json";
const ROOT_PREFIX = "ak-reviewer-lenses-";

type ReviewerWorktreeOwnership = {
  readonly sourceProjectRoot: string;
  readonly worktreeRoot: string;
  /** Detached worktree axis root (completeness|correctness); git remove target. */
  readonly projectRoot: string;
};

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

/** Admitted cwd may be the axis root or the caller's relative subdirectory under it. */
function admittedProjectMatchesWorktreeAxis(
  axisRoot: string,
  admittedProjectRoot: string,
): boolean {
  if (admittedProjectRoot === axisRoot) return true;
  const rel = relative(axisRoot, admittedProjectRoot);
  return rel !== "" && rel !== "." && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export async function recordReviewerWorktreeOwnership(
  runDirectory: string,
  ownership: ReviewerWorktreeOwnership,
): Promise<void> {
  await writeFile(
    join(runDirectory, OWNERSHIP_FILE),
    `${JSON.stringify(ownership, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function decodeOwnership(raw: unknown): ReviewerWorktreeOwnership {
  if (typeof raw !== "object" || raw === null) throw new Error("Reviewer worktree ownership is not an object");
  const value = raw as Record<string, unknown>;
  for (const key of ["sourceProjectRoot", "worktreeRoot", "projectRoot"] as const) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`Reviewer worktree ownership ${key} is missing`);
    }
  }
  return value as ReviewerWorktreeOwnership;
}

/**
 * Shared terminal lifecycle cleanup for a retained resumable Reviewer child.
 * Concurrent sibling resumes share one worktreeRoot: axis remove, ownership drop,
 * and empty-root reclaim are each idempotent (ENOENT / already-gone = success).
 * Unclean worktree remove still fails loud — no force delete.
 */
export async function cleanupReviewerWorktreeOwnership(
  runDirectory: string,
  admittedProjectRoot: string,
): Promise<void> {
  const path = join(runDirectory, OWNERSHIP_FILE);
  let ownership: ReviewerWorktreeOwnership;
  try {
    ownership = decodeOwnership(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

  const axis = basename(ownership.projectRoot);
  if (
    dirname(ownership.projectRoot) !== ownership.worktreeRoot
    || (axis !== "completeness" && axis !== "correctness")
    || !basename(ownership.worktreeRoot).startsWith(ROOT_PREFIX)
  ) {
    throw new Error("Reviewer worktree ownership does not match the admitted run");
  }

  const sourceProjectRoot = await realpath(ownership.sourceProjectRoot);
  const sourceTopLevel = await realpath((await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: sourceProjectRoot },
  )).stdout.trim());
  const sourceCommonDir = await realpath((await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: sourceProjectRoot },
  )).stdout.trim());
  if (sourceTopLevel !== sourceProjectRoot) {
    throw new Error("Reviewer worktree ownership does not match the admitted run");
  }

  // worktreeRoot may already be gone (sibling concurrent reclaim). Resolve when
  // present so macOS /var vs /private/var matches realpath(tmpdir()); when absent,
  // only the structural shape above is required for idempotent ownership drop.
  let worktreeRootReal: string | undefined;
  if (await pathExists(ownership.worktreeRoot)) {
    worktreeRootReal = await realpath(ownership.worktreeRoot);
    if (dirname(worktreeRootReal) !== await realpath(tmpdir())) {
      throw new Error("Reviewer worktree ownership does not match the admitted run");
    }
  }

  const axisStillPresent = await pathExists(ownership.projectRoot);
  if (axisStillPresent) {
    const projectRoot = await realpath(ownership.projectRoot);
    if (worktreeRootReal === undefined || dirname(projectRoot) !== worktreeRootReal) {
      throw new Error("Reviewer worktree ownership does not match the admitted run");
    }
    const admittedRoot = await realpath(admittedProjectRoot);
    if (!admittedProjectMatchesWorktreeAxis(projectRoot, admittedRoot)) {
      throw new Error("Reviewer worktree ownership does not match the admitted run");
    }
    const childCommonDir = await realpath((await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: projectRoot },
    )).stdout.trim());
    if (sourceCommonDir !== childCommonDir) {
      throw new Error("Reviewer worktree ownership does not match the admitted run");
    }
    // Unclean copies fail here and keep ownership for a later retry; never --force.
    await execFileAsync("git", ["worktree", "remove", projectRoot], {
      cwd: sourceProjectRoot,
    });
  } else if (await pathExists(admittedProjectRoot)) {
    // Axis path is gone but admitted cwd still resolves — refuse to drop ownership
    // without proving the admitted tree belonged to this axis.
    const admittedRoot = await realpath(admittedProjectRoot);
    if (!admittedProjectMatchesWorktreeAxis(ownership.projectRoot, admittedRoot)) {
      throw new Error("Reviewer worktree ownership does not match the admitted run");
    }
  }

  // Drop this run's claim once the axis is confirmed gone (or was already gone).
  // Ownership is per-child; concurrent siblings each own a distinct file.
  await rm(path, { force: true });

  // Shared root: empty → remove; already gone (sibling won the race) → success.
  try {
    if (worktreeRootReal === undefined) {
      if (!(await pathExists(ownership.worktreeRoot))) return;
      worktreeRootReal = await realpath(ownership.worktreeRoot);
    } else if (!(await pathExists(worktreeRootReal))) {
      return;
    }
    if ((await readdir(worktreeRootReal)).length === 0) {
      await rm(worktreeRootReal, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}
