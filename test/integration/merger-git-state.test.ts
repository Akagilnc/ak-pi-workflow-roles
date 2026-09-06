import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { createProductionMergerGitState } from "../../src/merger-git-state.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Module-level base with base/source/target commits; each case clones locally. */
let baseTemplateRoot: string | undefined;
let baseTemplateMemo: Promise<{ root: string; source: string; target: string }> | undefined;
async function baseTemplate() {
  baseTemplateMemo ??= (async () => {
    const root = await mkdtemp(worktreeTempPrefix("ak-merger-base-"));
    baseTemplateRoot = root;
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Merger Test");
    git(root, "config", "user.email", "merger@test.local");
    // Allow cloning a repo with an in-progress nothing; bare-ish local clones need this for file:// sometimes.
    git(root, "config", "uploadpack.allowAnySHA1InWant", "true");
    await writeFile(resolve(root, "conflict.txt"), "base\n");
    await writeFile(resolve(root, "unrelated.txt"), "unchanged\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    git(root, "checkout", "-b", "source");
    await writeFile(resolve(root, "conflict.txt"), "source\n");
    await writeFile(resolve(root, "source-only.txt"), "source only\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "source");
    const source = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    await writeFile(resolve(root, "conflict.txt"), "target\n");
    git(root, "commit", "-am", "target");
    const target = git(root, "rev-parse", "HEAD");
    return { root, source, target };
  })();
  return baseTemplateMemo;
}

after(async () => {
  if (baseTemplateRoot === undefined) return;
  const root = baseTemplateRoot;
  baseTemplateRoot = undefined;
  await rm(root, { recursive: true, force: true });
});

async function withConflictedRepo<T>(
  run: (fixture: { cwd: string; target: string; source: string }) => Promise<T>,
): Promise<T> {
  const template = await baseTemplate();
  return await withTempRoot("ak-merger-git-", async (cwd) => {
    execFileSync("git", ["clone", "--local", "--quiet", template.root, cwd], {
      stdio: "ignore",
    });
    git(cwd, "config", "user.name", "Merger Test");
    git(cwd, "config", "user.email", "merger@test.local");
    git(cwd, "branch", "source", "origin/source");
    assert.throws(() => git(cwd, "merge", "--no-edit", "source"));
    return await run({
      cwd,
      target: git(cwd, "rev-parse", "HEAD"),
      source: git(cwd, "rev-parse", "source"),
    });
    });
}

test("production Merger Git seam freezes the exact automatic merge tree and reports an unrelated resolution edit", async () => {
  await withConflictedRepo(async (fixture) => {
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
    git(fixture.cwd, "add", ".");
    git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual(await state.completedMerge(mergeCommitId, active.automaticMergeTreeId), {
      mergeCommitId,
      parentObjectIds: [fixture.target, fixture.source],
      unmergedPaths: [],
      worktreeClean: true,
      resolutionChangedPaths: ["conflict.txt", "unrelated.txt"],
    });
    await writeFile(resolve(fixture.cwd, "untracked.txt"), "dirty\n");
    assert.equal(
      (await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).worktreeClean,
      false,
    );
  });
});

test("production Merger Git seam rejects pre-existing tracked and untracked dirt", async () => {
  for (const dirt of ["tracked", "untracked"] as const) {
    await withConflictedRepo(async (fixture) => {
      if (dirt === "tracked") await writeFile(resolve(fixture.cwd, "unrelated.txt"), "opening tracked dirt\n");
      else await writeFile(resolve(fixture.cwd, "untracked.txt"), "opening untracked dirt\n");
      const state = createProductionMergerGitState(fixture.cwd);
      const active = await state.activeMerge();
      await writeFile(resolve(fixture.cwd, "conflict.txt"), "target and source\n");
      git(fixture.cwd, "add", "conflict.txt");
      git(fixture.cwd, "commit", "-m", "resolve assigned merge");
      const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
      assert.equal((await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).worktreeClean, false, dirt);
    });
  }
});

// resolutionChangedPaths matrix (#420 整改并一)：clean source-only first-parent
// change 与 tampered source-side path 同根「merge commit 的解析改动计算」，
// 收成一条两场景案。
test("production Merger Git seam computes resolutionChangedPaths across clean and tampered merge commits", async () => {
  // Scenario 1: clean resolve — only the conflict path counts; a source-only
  // first-parent change stays out of resolutionChangedPaths.
  await withConflictedRepo(async (fixture) => {
    const state = createProductionMergerGitState(fixture.cwd);
    const active = await state.activeMerge();
    await writeFile(resolve(fixture.cwd, "conflict.txt"), "target and source\n");
    git(fixture.cwd, "add", "conflict.txt");
    git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual(
      (await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).resolutionChangedPaths,
      ["conflict.txt"],
    );
    // source-only.txt is in first-parent diff but not in resolutionChangedPaths.
    assert.match(
      git(fixture.cwd, "diff", "--name-only", `${mergeCommitId}^1`, mergeCommitId),
      /source-only\.txt/,
    );
    assert.equal(
      (await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).resolutionChangedPaths.includes(
        "source-only.txt",
      ),
      false,
    );
  });

  // Scenario 2: tampering with a clean source-side path pulls it into the set.
  await withConflictedRepo(async (fixture) => {
    const state = createProductionMergerGitState(fixture.cwd);
    const active = await state.activeMerge();
    await writeFile(resolve(fixture.cwd, "conflict.txt"), "target and source\n");
    await writeFile(resolve(fixture.cwd, "source-only.txt"), "tampered\n");
    git(fixture.cwd, "add", ".");
    git(fixture.cwd, "commit", "-m", "resolve assigned merge");
    const mergeCommitId = git(fixture.cwd, "rev-parse", "HEAD");
    assert.deepEqual(
      (await state.completedMerge(mergeCommitId, active.automaticMergeTreeId)).resolutionChangedPaths,
      ["conflict.txt", "source-only.txt"],
    );
  });
});

test("production Merger Git seam reports no conflict set after a non-conflicting merge", async () => {
  const template = await baseTemplate();
  await withTempRoot("ak-merger-clean-", async (cwd) => {
    execFileSync("git", ["clone", "--local", "--quiet", template.root, cwd], {
      stdio: "ignore",
    });
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@test.local");
    git(cwd, "checkout", "-b", "clean-source");
    await writeFile(resolve(cwd, "clean-only.txt"), "clean\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "clean source");
    git(cwd, "checkout", "main");
    git(cwd, "merge", "--no-commit", "--no-ff", "clean-source");
    assert.deepEqual((await createProductionMergerGitState(cwd).activeMerge()).unmergedPaths, []);
    });
});
