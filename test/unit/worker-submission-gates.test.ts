/** #242 shortest real tracers — one bar per granted gate, positive+negative same bar. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkerSubmissionGate,
  installWorkerGitHooks,
  WorkerCommitReminderError,
  WORKER_COMMIT_SUBJECT_PREFIX,
} from "../../src/worker-submission-gates.ts";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function tempGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ak-worker-gate-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "gate@test.local"]);
  git(root, ["config", "user.name", "Gate Test"]);
  git(root, ["commit", "--allow-empty", "-m", "seed"]);
  return root;
}

test("① completed/partially_completed zero-commit bounces once then confirm; other statuses free; git failure surfaces; unborn is no-commit", async () => {
  const root = await tempGitRepo();
  const bare = await mkdtemp(join(tmpdir(), "ak-worker-gate-bare-"));
  try {
    const gate = createWorkerSubmissionGate();
    gate.arm(root);
    for (const status of ["planned", "refused", "unfinished"] as const) {
      assert.doesNotThrow(() => gate.assertAcceptable(status), status);
    }
    assert.throws(
      () => gate.assertAcceptable("completed"),
      (error: unknown) =>
        error instanceof WorkerCommitReminderError &&
        error.code === "worker_commit_reminder" &&
        error.message === "未观察到 commit",
    );
    assert.doesNotThrow(() => gate.assertAcceptable("completed"));
    const gate2 = createWorkerSubmissionGate();
    gate2.arm(root);
    assert.throws(() => gate2.assertAcceptable("partially_completed"), WorkerCommitReminderError);
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} work`]);
    const gate3 = createWorkerSubmissionGate();
    gate3.arm(root);
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} more`]);
    assert.doesNotThrow(() => gate3.assertAcceptable("completed"));

    // Real git failure must not be mislabeled as「未观察到 commit」.
    const dead = createWorkerSubmissionGate();
    assert.throws(() => dead.arm(bare), /not a git repository/);

    // Unborn HEAD is the sole legitimate no-commit baseline.
    const unborn = await mkdtemp(join(tmpdir(), "ak-worker-gate-unborn-"));
    try {
      git(unborn, ["init", "-b", "main"]);
      git(unborn, ["config", "user.email", "gate@test.local"]);
      git(unborn, ["config", "user.name", "Gate Test"]);
      const g = createWorkerSubmissionGate();
      g.arm(unborn);
      assert.throws(() => g.assertAcceptable("completed"), WorkerCommitReminderError);
    } finally {
      await rm(unborn, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("②④ bad title/empty subject/amend rejected; fixed title, new commit, pre-existing history pass; armed tree only", async () => {
  const root = await tempGitRepo();
  try {
    // Production shape: linked worktrees exist first; install arms one tree only.
    const wt = join(root, "wt-linked");
    const sibling = join(root, "wt-sibling");
    git(root, ["worktree", "add", wt, "HEAD"]);
    git(root, ["worktree", "add", sibling, "HEAD"]);
    installWorkerGitHooks(wt);

    const headBeforeBad = git(wt, ["rev-parse", "HEAD"]);
    assert.throws(
      () => git(wt, ["commit", "--allow-empty", "-m", "missing prefix"]),
      /ak-roles: commit subject must start with ak-roles:/,
    );
    assert.equal(git(wt, ["rev-parse", "HEAD"]), headBeforeBad);
    // Empty subject is illegal on newly-created commits (not pre-existing history).
    const tree = git(wt, ["write-tree"]);
    const parent = git(wt, ["rev-parse", "HEAD"]);
    const emptyCommit = execFileSync("git", ["commit-tree", tree, "-p", parent], {
      cwd: wt, encoding: "utf8", input: "",
    }).trim();
    assert.throws(
      () => git(wt, ["update-ref", "HEAD", emptyCommit]),
      /ak-roles: commit subject must start with ak-roles:/,
    );
    assert.equal(git(wt, ["rev-parse", "HEAD"]), headBeforeBad);
    git(wt, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} lawful`]);
    const afterGood = git(wt, ["rev-parse", "HEAD"]);
    assert.throws(
      () => git(wt, ["commit", "--allow-empty", "--amend", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} amended`]),
      /non-fast-forward|amend/i,
    );
    assert.equal(git(wt, ["rev-parse", "HEAD"]), afterGood);
    git(wt, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} forward`]);
    assert.notEqual(git(wt, ["rev-parse", "HEAD"]), afterGood);
    await writeFile(join(wt, "dirt.txt"), "dirty\n");
    git(wt, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} still ok dirty`]);

    // Unarmed main + sibling unconstrained (hook bound to armed worktree only).
    git(root, ["commit", "--allow-empty", "-m", "main unprefixed ok"]);
    git(sibling, ["commit", "--allow-empty", "-m", "sibling unprefixed ok"]);

    // Pre-existing unprefixed history must not be re-checked on ref creation.
    const seed = git(wt, ["rev-list", "--max-parents=0", "HEAD"]);
    git(wt, ["branch", "seed-alias", seed]);
    git(wt, ["checkout", "-b", "topic"]);
    git(wt, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} topic tip`]);
    git(wt, ["checkout", "-b", "integration", "seed-alias"]);
    git(wt, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} integration base`]);
    git(wt, ["merge", "--no-ff", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} merge topic`, "topic"]);

    // Foreign reference-transaction hook → fails closed, no silent overwrite.
    const hooksDir = git(wt, ["config", "--get", "core.hooksPath"]);
    const hookPath = join(hooksDir, "reference-transaction");
    await writeFile(hookPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(hookPath, 0o755);
    assert.throws(() => installWorkerGitHooks(wt), /refusing to overwrite existing reference-transaction hook/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
