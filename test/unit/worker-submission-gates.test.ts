/** #242 shortest real tracers — one bar per granted gate, positive+negative same bar. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkerSubmissionGate,
  installWorkerGitHooks,
  WorkerCommitReminderError,
  WORKER_COMMIT_SUBJECT_PREFIX,
  WORKER_SUBMISSION_GATE_SITIAN_DEPENDENCY,
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
    assert.equal(WORKER_SUBMISSION_GATE_SITIAN_DEPENDENCY.issue, 216);
    assert.equal(WORKER_SUBMISSION_GATE_SITIAN_DEPENDENCY.status, "blocked_on_sitian_unique_entry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("②④ bad title and amend rejected by hook; fixed title and new commit pass", async () => {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
