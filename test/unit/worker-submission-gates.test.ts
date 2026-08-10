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

test("① completed/partially_completed zero-commit bounces once then confirm; other statuses free", async () => {
  const root = await tempGitRepo();
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("②④ bad title and amend rejected by hook; fixed title, new commit, and pre-existing history pass", async () => {
  const root = await tempGitRepo();
  try {
    installWorkerGitHooks(root);
    const headBeforeBad = git(root, ["rev-parse", "HEAD"]);
    assert.throws(
      () => git(root, ["commit", "--allow-empty", "-m", "missing prefix"]),
      /ak-roles: commit subject must start with ak-roles:/,
    );
    assert.equal(git(root, ["rev-parse", "HEAD"]), headBeforeBad);
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} lawful`]);
    const afterGood = git(root, ["rev-parse", "HEAD"]);
    assert.throws(
      () => git(root, ["commit", "--allow-empty", "--amend", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} amended`]),
      /non-fast-forward|amend/i,
    );
    assert.equal(git(root, ["rev-parse", "HEAD"]), afterGood);
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} forward`]);
    assert.notEqual(git(root, ["rev-parse", "HEAD"]), afterGood);
    await writeFile(join(root, "dirt.txt"), "dirty\n");
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} still ok dirty`]);

    // Pre-existing unprefixed history must not be re-checked on ref creation / no-ff merge.
    git(root, ["checkout", "-b", "topic"]);
    git(root, ["branch", "topic-alias"]);
    git(root, ["checkout", "main"]);
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} mainline`]);
    git(root, ["merge", "--no-ff", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} merge topic`, "topic"]);

    // Linked worktree shares hooks dir — refuse install (do not lock sibling trees).
    const wt = join(root, "wt-linked");
    git(root, ["worktree", "add", wt]);
    assert.throws(() => installWorkerGitHooks(wt), /linked worktree shared hooks dir/);
    // Main tree still commits; linked install refusal must not have clobbered the hook.
    git(root, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} after linked refuse`]);

    // Foreign reference-transaction hook → fails closed, no silent overwrite.
    const hooksDir = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
    const hookPath = join(hooksDir, "reference-transaction");
    await writeFile(hookPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(hookPath, 0o755);
    assert.throws(() => installWorkerGitHooks(root), /refusing to overwrite existing reference-transaction hook/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
