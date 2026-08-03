import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createProductionMergerGitState } from "../src/merger-git-state.ts";
import { withPrimaryAwareCleanup } from "./helpers/primary-aware-cleanup.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function conflictedRepo() {
  const cwd = await mkdtemp(resolve(tmpdir(), "ak-merger-git-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Merger Test"); git(cwd, "config", "user.email", "merger@test.local");
  await writeFile(resolve(cwd, "conflict.txt"), "base\n"); await writeFile(resolve(cwd, "unrelated.txt"), "unchanged\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "source"); await writeFile(resolve(cwd, "conflict.txt"), "source\n"); await writeFile(resolve(cwd, "source-only.txt"), "source only\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "source"); const source = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "main"); await writeFile(resolve(cwd, "conflict.txt"), "target\n"); git(cwd, "commit", "-am", "target"); const target = git(cwd, "rev-parse", "HEAD");
  assert.throws(() => git(cwd, "merge", "--no-edit", source));
  return { cwd, target, source };
}

test("production Merger Git seam freezes the exact automatic merge tree and reports an unrelated resolution edit", async () => {
  const fixture = await conflictedRepo();
  await withPrimaryAwareCleanup(async () => {
    const state = createProductionMergerGitState(fixture.cwd);
    const active = await state.activeMerge();
    assert.deepEqual(active, {
      targetObjectId: fixture.target,
      sourceObjectId: fixture.source,
      unmergedPaths: ["conflict.txt"],
      automaticMergeTreeId: active.automaticMergeTreeId,
    });
    assert.match(active.automaticMergeTreeId, /^[0-9a-f]{40,64}$/);
    await writeFile(resolve(fixture.cwd, "conflict.txt"), "target and source\n");
    await writeFile(resolve(fixture.cwd, "unrelated.txt"), "tampered\n");
    git(fixture.cwd, "add", "."); git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual(await state.completedMerge(mergeCommitId, active.automaticMergeTreeId), {
      mergeCommitId,
      parentObjectIds: [fixture.target, fixture.source],
      unmergedPaths: [],
      worktreeClean: true,
      resolutionChangedPaths: ["conflict.txt", "unrelated.txt"],
    });
    await writeFile(resolve(fixture.cwd, "untracked.txt"), "dirty\n");
    assert.equal((await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).worktreeClean, false);
  }, () => rm(fixture.cwd, { recursive: true, force: true }));
});

test("production Merger Git seam accepts a clean source-only first-parent change", async () => {
  const fixture = await conflictedRepo();
  await withPrimaryAwareCleanup(async () => {
    const state = createProductionMergerGitState(fixture.cwd); const active = await state.activeMerge();
    await writeFile(resolve(fixture.cwd, "conflict.txt"), "target and source\n"); git(fixture.cwd, "add", "conflict.txt"); git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual((await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).resolutionChangedPaths, ["conflict.txt"]);
    assert.match(git(fixture.cwd, "diff", "--name-only", `${mergeCommitId}^1`, mergeCommitId), /source-only\.txt/);
  }, () => rm(fixture.cwd, { recursive: true, force: true }));
});

test("production Merger Git seam reports tampering with a clean source-side path", async () => {
  const fixture = await conflictedRepo();
  await withPrimaryAwareCleanup(async () => {
    const state = createProductionMergerGitState(fixture.cwd); const active = await state.activeMerge();
    await writeFile(resolve(fixture.cwd, "conflict.txt"), "target and source\n"); await writeFile(resolve(fixture.cwd, "source-only.txt"), "tampered\n"); git(fixture.cwd, "add", "."); git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual((await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).resolutionChangedPaths, ["conflict.txt", "source-only.txt"]);
  }, () => rm(fixture.cwd, { recursive: true, force: true }));
});

test("production Merger Git seam reports no conflict set after a non-conflicting merge", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ak-merger-clean-"));
  await withPrimaryAwareCleanup(async () => {
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@test.local");
    await writeFile(resolve(cwd, "base"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "base"); git(cwd, "checkout", "-b", "source"); await writeFile(resolve(cwd, "source"), "source\n"); git(cwd, "add", "."); git(cwd, "commit", "-m", "source"); const source = git(cwd, "rev-parse", "HEAD"); git(cwd, "checkout", "main");
    git(cwd, "merge", "--no-commit", "--no-ff", source);
    assert.deepEqual((await createProductionMergerGitState(cwd).activeMerge()).unmergedPaths, []);
  }, () => rm(cwd, { recursive: true, force: true }));
});
