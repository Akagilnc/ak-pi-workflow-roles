import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createProductionMergerGitState } from "../src/merger-git-state.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function conflictedRepo() {
  const cwd = await mkdtemp(resolve(tmpdir(), "ak-merger-git-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Merger Test"); git(cwd, "config", "user.email", "merger@test.local");
  await writeFile(resolve(cwd, "same.txt"), "base\n"); git(cwd, "add", "same.txt"); git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "source"); await writeFile(resolve(cwd, "same.txt"), "source\n"); git(cwd, "commit", "-am", "source"); const source = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "main"); await writeFile(resolve(cwd, "same.txt"), "target\n"); git(cwd, "commit", "-am", "target"); const target = git(cwd, "rev-parse", "HEAD");
  assert.throws(() => git(cwd, "merge", "--no-edit", source));
  return { cwd, target, source };
}

test("production Merger Git seam observes exact active merge and verifies its ordinary clean two-parent commit", async () => {
  const fixture = await conflictedRepo();
  try {
    const state = createProductionMergerGitState(fixture.cwd);
    assert.deepEqual(await state.activeMerge(), { targetObjectId: fixture.target, sourceObjectId: fixture.source, unmergedPaths: ["same.txt"] });
    await writeFile(resolve(fixture.cwd, "same.txt"), "target and source\n"); git(fixture.cwd, "add", "same.txt"); git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual(await state.completedMerge(mergeCommitId), { mergeCommitId, parentObjectIds: [fixture.target, fixture.source], unmergedPaths: [], worktreeClean: true });
    await writeFile(resolve(fixture.cwd, "untracked.txt"), "dirty\n");
    assert.equal((await state.completedMerge(mergeCommitId)).worktreeClean, false);
  } finally { await rm(fixture.cwd, { recursive: true, force: true }); }
});

test("production Merger Git seam reports no conflict set after a non-conflicting merge", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ak-merger-clean-"));
  try {
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@test.local");
    await writeFile(resolve(cwd, "base"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "base"); git(cwd, "checkout", "-b", "source"); await writeFile(resolve(cwd, "source"), "source\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "source"); const source = git(cwd, "rev-parse", "HEAD"); git(cwd, "checkout", "main");
    git(cwd, "merge", "--no-commit", "--no-ff", source);
    assert.deepEqual((await createProductionMergerGitState(cwd).activeMerge()).unmergedPaths, []);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
