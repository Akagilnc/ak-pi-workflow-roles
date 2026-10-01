import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seedGitProject } from "./failure-settlement-kit.ts";

/** Real unresolved merge for the public Merger entry; no swallowed setup failure. */
export async function materializeConflictedRepo(root: string): Promise<{
  target: string;
  source: string;
  conflictPath: string;
}> {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  seedGitProject(root);
  await writeFile(join(root, "same.txt"), "base\n");
  git("add", "same.txt");
  git("commit", "-m", "base");
  git("checkout", "-b", "source");
  await writeFile(join(root, "same.txt"), "source\n");
  git("commit", "-am", "source");
  const source = git("rev-parse", "HEAD");
  git("checkout", "main");
  await writeFile(join(root, "same.txt"), "target\n");
  git("commit", "-am", "target");
  const target = git("rev-parse", "HEAD");
  assert.throws(() => git("merge", "--no-edit", "source"));
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), "same.txt");
  return { target, source, conflictPath: "same.txt" };
}
