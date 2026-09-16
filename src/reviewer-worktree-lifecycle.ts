import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OWNERSHIP_FILE = "reviewer-worktree-ownership.json";

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

/** Shared terminal lifecycle cleanup for a retained resumable Reviewer child. */
export async function cleanupReviewerWorktreeOwnership(runDirectory: string): Promise<void> {
  const path = join(runDirectory, OWNERSHIP_FILE);
  let ownership: ReviewerWorktreeOwnership;
  try {
    ownership = JSON.parse(await readFile(path, "utf8")) as ReviewerWorktreeOwnership;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await execFileAsync("git", ["worktree", "remove", ownership.projectRoot], {
    cwd: ownership.sourceProjectRoot,
  });
  if ((await readdir(ownership.worktreeRoot)).length === 0) {
    await rm(ownership.worktreeRoot, { recursive: true });
  }
  await rm(path);
}
