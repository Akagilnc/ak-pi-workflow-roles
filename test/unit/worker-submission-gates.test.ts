/** #242 shortest real tracers — one bar per granted gate, positive+negative same bar. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createWorkerSubmissionGate,
  installWorkerGitHooks,
  WorkerCommitReminderError,
  WORKER_COMMIT_BASELINE_ENTRY_TYPE,
  WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE,
  WORKER_COMMIT_SUBJECT_PREFIX,
  WORKER_SUBMISSION_GATE_RECORD_KIND,
} from "../../src/worker-submission-gates.ts";
import {
  machineLedgerHome,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

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

    // Own-package prior hook body (marker present, content differs) must reload.
    const hooksDir = git(wt, ["config", "--get", "core.hooksPath"]);
    const hookPath = join(hooksDir, "reference-transaction");
    const priorOwn = `#!/bin/sh
# ak-roles: worker-submission-gates reference-transaction
# prior package revision body
exit 0
`;
    await writeFile(hookPath, priorOwn, "utf8");
    chmodSync(hookPath, 0o755);
    assert.doesNotThrow(() => installWorkerGitHooks(wt));
    assert.match(await import("node:fs/promises").then((fs) => fs.readFile(hookPath, "utf8")), /rev-list/);

    // Foreign reference-transaction hook → fails closed, no silent overwrite.
    await writeFile(hookPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(hookPath, 0o755);
    assert.throws(() => installWorkerGitHooks(wt), /refusing to overwrite existing reference-transaction hook/);

    // Invariant 1 — bare host + linked worktrees: arm one tree, siblings stay work trees.
    // Probe lives only under tmpdir; never arm the real host repo.
    const probe = mkdtempSync(join(tmpdir(), "ak-worker-gate-bare-host-"));
    try {
      const seedRepo = join(probe, "seed");
      const host = join(probe, "host.git");
      const wtA = join(probe, "wtA");
      const wtB = join(probe, "wtB");
      git(probe, ["init", "-b", "main", seedRepo]);
      git(seedRepo, ["config", "user.email", "gate@test.local"]);
      git(seedRepo, ["config", "user.name", "Gate Test"]);
      git(seedRepo, ["commit", "--allow-empty", "-m", "seed"]);
      execFileSync("git", ["clone", "--bare", seedRepo, host], {
        cwd: probe, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      git(host, ["worktree", "add", wtA, "main"]);
      git(host, ["worktree", "add", "-b", "side", wtB, "main"]);
      git(wtA, ["config", "user.email", "gate@test.local"]);
      git(wtA, ["config", "user.name", "Gate Test"]);
      git(wtB, ["config", "user.email", "gate@test.local"]);
      git(wtB, ["config", "user.name", "Gate Test"]);

      assert.equal(git(wtA, ["status", "--porcelain"]), "");
      assert.equal(git(wtB, ["status", "--porcelain"]), "");
      // Bare host itself is not a work tree — fail closed before shared-config damage.
      assert.throws(() => installWorkerGitHooks(host), /outside a git work tree/);
      assert.equal(git(wtA, ["status", "--porcelain"]), "");
      assert.equal(git(wtB, ["status", "--porcelain"]), "");

      installWorkerGitHooks(wtA);
      // Armed + never-armed sibling both remain usable work trees.
      assert.equal(git(wtA, ["status", "--porcelain"]), "");
      assert.equal(git(wtB, ["status", "--porcelain"]), "");
      assert.throws(
        () => git(wtA, ["commit", "--allow-empty", "-m", "no prefix"]),
        /ak-roles: commit subject must start with ak-roles:/,
      );
      // Sibling never armed — unconstrained.
      git(wtB, ["commit", "--allow-empty", "-m", "sibling unprefixed ok on bare host"]);
      git(wtA, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} bare-host armed ok`]);
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#267 when extensions.worktreeConfig already true, install skips shared .git/config write", async () => {
  // Real entry: installWorkerGitHooks. Observable: shared config.lock held → still succeeds
  // (proves no shared write); worktree-local hooks still armed.
  const root = await tempGitRepo();
  try {
    const wt = join(root, "wt-267");
    git(root, ["worktree", "add", wt, "HEAD"]);
    // First arm establishes the extension (shared write once).
    installWorkerGitHooks(wt);
    assert.equal(git(wt, ["config", "--get", "extensions.worktreeConfig"]), "true");

    const commonDir = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const lockPath = join(commonDir, "config.lock");
    // Simulate sibling activation holding the shared lock (production race shape).
    writeFileSync(lockPath, "");
    try {
      assert.doesNotThrow(() => installWorkerGitHooks(wt));
      assert.equal(git(wt, ["config", "--get", "extensions.worktreeConfig"]), "true");
      const hooksDir = git(wt, ["config", "--get", "core.hooksPath"]);
      assert.match(hooksDir, /ak-roles-hooks$/);
      assert.throws(
        () => git(wt, ["commit", "--allow-empty", "-m", "no prefix"]),
        /ak-roles: commit subject must start with ak-roles:/,
      );
    } finally {
      await rm(lockPath, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("① durability: baseline+bounce via real createRecordSession survive resume; no second false bounce", async () => {
  await withHermeticHome({ prefix: "ak-worker-gate-durable-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    git(project, ["config", "user.email", "gate@test.local"]);
    git(project, ["config", "user.name", "Gate Test"]);
    git(project, ["commit", "--allow-empty", "-m", "seed"]);
    const baselineHead = git(project, ["rev-parse", "HEAD"]);

    // Durable parent under ledger home — production nest shape (ADR 0065 / #216).
    const parentDir = join(
      machineLedgerHome(home),
      "books",
      "proj",
      "runs",
      "activation",
      "worker-run",
    );
    await mkdir(parentDir, { recursive: true });
    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "worker-parent",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project,
      })}\n`,
    );
    const parent = SessionManager.open(parentFile);

    // First process: arm + zero-commit completed → bounce once.
    const first = createWorkerSubmissionGate();
    first.arm(project, parent);
    assert.throws(() => first.assertAcceptable("completed"), WorkerCommitReminderError);

    // Records must land under parent nest via sitian kind (not a parallel ledger path).
    const nest = join(dirname(parentFile), WORKER_SUBMISSION_GATE_RECORD_KIND);
    const files = readdirSync(nest).filter((name) => name.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const body = readFileSync(join(nest, files[0]!), "utf8");
    assert.match(body, new RegExp(WORKER_COMMIT_BASELINE_ENTRY_TYPE));
    assert.match(body, new RegExp(WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE));
    assert.match(body, new RegExp(baselineHead));

    // Advance HEAD after bounce — baseline must stay the first-arm tip across resume.
    git(project, ["commit", "--allow-empty", "-m", `${WORKER_COMMIT_SUBJECT_PREFIX} after bounce`]);

    // Fresh gate instance ≡ process resume: must not re-bounce; baseline still first tip.
    const resumed = createWorkerSubmissionGate();
    resumed.arm(project, parent);
    assert.doesNotThrow(() => resumed.assertAcceptable("completed"));

    // Baseline persistence (no bounce path): new arm after only baseline, HEAD unchanged → bounce;
    // then a third instance that only saw the bounce record must accept without re-firing.
    const project2 = join(home, "proj2");
    await mkdir(project2, { recursive: true });
    seedGitRepository(project2);
    git(project2, ["config", "user.email", "gate@test.local"]);
    git(project2, ["config", "user.name", "Gate Test"]);
    git(project2, ["commit", "--allow-empty", "-m", "seed2"]);
    const parent2Dir = join(
      machineLedgerHome(home),
      "books",
      "proj2",
      "runs",
      "activation",
      "worker-run-2",
    );
    await mkdir(parent2Dir, { recursive: true });
    const parent2File = join(parent2Dir, "session.jsonl");
    await writeFile(
      parent2File,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "worker-parent-2",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project2,
      })}\n`,
    );
    const parent2 = SessionManager.open(parent2File);
    const a = createWorkerSubmissionGate();
    a.arm(project2, parent2);
    assert.throws(() => a.assertAcceptable("completed"), WorkerCommitReminderError);
    const b = createWorkerSubmissionGate();
    b.arm(project2, parent2);
    // Same HEAD, already reminded once on durable record — confirm path, no second bounce.
    assert.doesNotThrow(() => b.assertAcceptable("completed"));
    assert.doesNotThrow(() => b.assertAcceptable("partially_completed"));
  });
});
