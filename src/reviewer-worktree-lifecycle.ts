import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OWNERSHIP_FILE = "reviewer-worktree-ownership.json";
const ROOT_PREFIX = "ak-reviewer-lenses-";

type ReviewerWorktreeOwnership = {
  readonly sourceProjectRoot: string;
  readonly worktreeRoot: string;
  readonly projectRoot: string;
};

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

/** Shared terminal lifecycle cleanup for a retained resumable Reviewer child. */
export async function cleanupReviewerWorktreeOwnership(
  runDirectory: string,
  admittedProjectRoot: string,
): Promise<void> {
  const path = join(runDirectory, OWNERSHIP_FILE);
  let ownership: ReviewerWorktreeOwnership;
  try {
    ownership = decodeOwnership(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const projectRoot = await realpath(ownership.projectRoot);
  const worktreeRoot = await realpath(ownership.worktreeRoot);
  const sourceProjectRoot = await realpath(ownership.sourceProjectRoot);
  const childCommonDir = await realpath((await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: projectRoot },
  )).stdout.trim());
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
  const axis = basename(projectRoot);
  if (
    projectRoot !== await realpath(admittedProjectRoot)
    || dirname(projectRoot) !== worktreeRoot
    || (axis !== "completeness" && axis !== "correctness")
    || !basename(worktreeRoot).startsWith(ROOT_PREFIX)
    || dirname(worktreeRoot) !== await realpath(tmpdir())
    || sourceTopLevel !== sourceProjectRoot
    || sourceCommonDir !== childCommonDir
  ) {
    throw new Error("Reviewer worktree ownership does not match the admitted run");
  }
  await execFileAsync("git", ["worktree", "remove", projectRoot], {
    cwd: sourceProjectRoot,
  });
  if ((await readdir(worktreeRoot)).length === 0) {
    await rm(worktreeRoot, { recursive: true });
  }
  await rm(path);
}
