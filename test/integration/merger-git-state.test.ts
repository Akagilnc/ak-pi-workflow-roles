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

test("production Merger Git seam reads conflicted merge materials without gating", async () => {
  await withConflictedRepo(async (fixture) => {
    const state = createProductionMergerGitState(fixture.cwd);
    const active = await state.activeMerge();
    assert.deepEqual(active, {
      targetObjectId: fixture.target,
      sourceObjectId: fixture.source,
      unmergedPaths: ["conflict.txt"],
    });
  });
});

test("production Merger Git seam returns empty materials when no merge is in progress", async () => {
  await withTempRoot("ak-merger-clean-head-", async (cwd) => {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.name", "Merger Test");
    git(cwd, "config", "user.email", "merger@test.local");
    git(cwd, "commit", "--allow-empty", "-m", "seed");
    const head = git(cwd, "rev-parse", "HEAD");
    const active = await createProductionMergerGitState(cwd).activeMerge();
    assert.equal(active.targetObjectId, head);
    assert.equal(active.sourceObjectId, "");
    assert.deepEqual(active.unmergedPaths, []);
  });
});

test("production Merger Git seam reports no conflict set after a non-conflicting merge start", async () => {
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
    const active = await createProductionMergerGitState(cwd).activeMerge();
    assert.deepEqual(active.unmergedPaths, []);
    assert.equal(active.sourceObjectId.length > 0, true);
  });
});
