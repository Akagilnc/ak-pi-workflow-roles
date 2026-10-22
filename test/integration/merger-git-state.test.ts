import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";
import { createProductionMergerGitState } from "../../src/merger-git-state.ts";
import { seedGitRepository, withTempRoot } from "../helpers/environment-fixtures.ts";
import { seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { materializeConflictedRepo } from "../helpers/merger-conflict-fixture.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

async function withConflictedRepo<T>(
  run: (fixture: { cwd: string; target: string; source: string; conflictPath: string }) => Promise<T>,
): Promise<T> {
  return await withTempRoot("ak-merger-git-", async (cwd) => run({ cwd, ...await materializeConflictedRepo(cwd) }));
}

test("production Merger Git seam reads conflicted merge materials without gating", async () => {
  await withConflictedRepo(async (fixture) => {
    const state = createProductionMergerGitState(fixture.cwd);
    const active = await state.activeMerge();
    assert.deepEqual(active, {
      targetObjectId: fixture.target,
      sourceObjectId: fixture.source,
      unmergedPaths: [fixture.conflictPath],
    });
  });
});

test("production Merger Git seam returns empty materials when no merge is in progress", async () => {
  await withTempRoot("ak-merger-clean-head-", async (cwd) => {
    seedGitProject(cwd);
    const head = git(cwd, "rev-parse", "HEAD");
    const active = await createProductionMergerGitState(cwd).activeMerge();
    assert.equal(active.targetObjectId, head);
    assert.equal(active.sourceObjectId, "");
    assert.deepEqual(active.unmergedPaths, []);
  });
});

test("production Merger Git seam keeps non-repository infrastructure failures loud", async () => {
  await withTempRoot("ak-merger-not-git-", async (cwd) => {
    // Temp roots live under the package worktree; a broken local gitfile blocks parent discovery.
    // Infrastructure failure must reject — not project as empty merge materials.
    await writeFile(resolve(cwd, ".git"), "gitdir: /nonexistent-git-dir-827\n");
    await assert.rejects(
      () => createProductionMergerGitState(cwd).activeMerge(),
      Error,
    );
  });
});

test("production Merger Git seam keeps corrupt MERGE_HEAD loud", async () => {
  await withTempRoot("ak-merger-corrupt-merge-", async (cwd) => {
    seedGitProject(cwd);
    const mergeHeadPath = git(cwd, "rev-parse", "--git-path", "MERGE_HEAD");
    await writeFile(
      resolve(cwd, mergeHeadPath),
      "not-a-git-object-id\n",
    );
    await assert.rejects(
      () => createProductionMergerGitState(cwd).activeMerge(),
      Error,
    );
  });
});

test("production Merger Git seam keeps corrupt detached HEAD loud", async () => {
  await withTempRoot("ak-merger-corrupt-head-", async (cwd) => {
    seedGitProject(cwd);
    await writeFile(
      resolve(cwd, ".git", "HEAD"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    await assert.rejects(
      () => createProductionMergerGitState(cwd).activeMerge(),
      Error,
    );
  });
});

test("production Merger Git seam returns empty materials for unborn repo", async () => {
  await withTempRoot("ak-merger-unborn-", async (cwd) => {
    seedGitRepository(cwd);
    const active = await createProductionMergerGitState(cwd).activeMerge();
    assert.deepEqual(active, {
      targetObjectId: "",
      sourceObjectId: "",
      unmergedPaths: [],
    });
  });
});

test("production Merger Git seam reports no conflict set after a non-conflicting merge start", async () => {
  await withTempRoot("ak-merger-clean-", async (cwd) => {
    seedGitProject(cwd);
    git(cwd, "checkout", "-b", "clean-source");
    await writeFile(resolve(cwd, "clean-only.txt"), "clean\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "clean source");
    git(cwd, "checkout", "main");
    git(cwd, "merge", "--no-commit", "--no-ff", "clean-source");
    const active = await createProductionMergerGitState(cwd).activeMerge();
    assert.deepEqual(active.unmergedPaths, []);
    assert.equal(active.sourceObjectId.length > 0, true);
  });
});
