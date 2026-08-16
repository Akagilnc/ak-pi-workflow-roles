/** #242 shortest real tracers — one bar per granted gate, positive+negative same bar. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  buildNavigatorInfrastructureFailureFact,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/role-runtime.ts";
import { createRecordSession } from "../../src/sitian-record-entry.ts";
import {
  createWorkerSubmissionGate,
  installWorkerGitHooks,
  migrateWorkerGitHookScope,
  WorkerCommitReminderError,
  WorkerUnfinishedReasonReminderError,
  WORKER_COMMIT_BASELINE_ENTRY_TYPE,
  WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE,
  WORKER_SUBMISSION_GATE_RECORD_KIND,
} from "../../src/worker-submission-gates.ts";

/** Factory naming discipline sample — open-set gate accepts any platform prefix. */
const FACTORY_PREFIX = "ak-roles:";
import {
  machineLedgerHome,
  packageRoot,
  resolvePackageEntrypoint,
  seedGitRepository,
  withHermeticHome,
  withInProcessPi,
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

test("unfinished reason gate bounces missing reason up to twice then accepts; reasoned unfinished free; other statuses unchanged", () => {
  const gate = createWorkerSubmissionGate();
  assert.throws(
    () => gate.assertAcceptable("unfinished", {}),
    (error: unknown) =>
      error instanceof WorkerUnfinishedReasonReminderError &&
      error.code === "worker_unfinished_reason_reminder" &&
      error.message === "补理由（前置缺失/违宪之一）或继续施工",
  );
  assert.throws(() => gate.assertAcceptable("unfinished", { reason: "   " }), WorkerUnfinishedReasonReminderError);
  assert.doesNotThrow(() =>
    gate.assertAcceptable("unfinished", {
      reason: "prerequisite_missing: pending owner decision on adapter scope",
    }),
  );

  const loop = createWorkerSubmissionGate();
  assert.throws(() => loop.assertAcceptable("unfinished", {}), WorkerUnfinishedReasonReminderError);
  assert.throws(() => loop.assertAcceptable("unfinished", {}), WorkerUnfinishedReasonReminderError);
  assert.doesNotThrow(() => loop.assertAcceptable("unfinished", {}));
  assert.doesNotThrow(() => loop.assertAcceptable("planned"));
  assert.doesNotThrow(() => loop.assertAcceptable("refused"));
});

test("① completed/partially_completed zero-commit bounces once then confirm; other statuses free; git failure surfaces; unborn is no-commit", async () => {
  const root = await tempGitRepo();
  const bare = await mkdtemp(join(tmpdir(), "ak-worker-gate-bare-"));
  try {
    const gate = createWorkerSubmissionGate();
    gate.arm(root);
    for (const status of ["planned", "refused"] as const) {
      assert.doesNotThrow(() => gate.assertAcceptable(status), status);
    }
    // unfinished without reason is the reason-gate's concern; with reason it stays commit-free.
    assert.doesNotThrow(() =>
      gate.assertAcceptable("unfinished", { reason: "unconstitutional: task contradicts ADR 0055" }),
    );
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
    git(root, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} work`]);
    const gate3 = createWorkerSubmissionGate();
    gate3.arm(root);
    git(root, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} more`]);
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

test("②④ open prefix/empty subject/amend; scope worktree-only; main multi-wt refused; merge exempt", async () => {
  const root = await tempGitRepo();
  try {
    // Production shape: linked worktrees exist first; install arms one tree only.
    const wt = join(root, "wt-linked");
    const sibling = join(root, "wt-sibling");
    git(root, ["worktree", "add", wt, "HEAD"]);
    git(root, ["worktree", "add", sibling, "HEAD"]);

    // Main of a multi-worktree repo is not an envelope worker tree — refuse.
    assert.throws(
      () => installWorkerGitHooks(root),
      /main worktree of a multi-worktree repo/,
    );

    installWorkerGitHooks(wt);

    // Real git config observation: common has no hooksPath; only armed worktree carries it.
    const commonDir = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonConfig = join(commonDir, "config");
    // git config --get exits 1 when unset.
    try {
      execFileSync("git", ["config", "--file", commonConfig, "--get", "core.hooksPath"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("common core.hooksPath must be unset");
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }
    const hooksDir = git(wt, ["config", "--worktree", "--get", "core.hooksPath"]);
    assert.match(hooksDir, /ak-roles-hooks/);
    const wtGitDir = git(wt, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    assert.equal(hooksDir, join(wtGitDir, "ak-roles-hooks"));

    const headBeforeBad = git(wt, ["rev-parse", "HEAD"]);
    assert.throws(
      () => git(wt, ["commit", "--allow-empty", "-m", "missing prefix"]),
      /missing platform prefix/,
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
      /missing platform prefix/,
    );
    assert.equal(git(wt, ["rev-parse", "HEAD"]), headBeforeBad);
    // Open set: any platform prefix is lawful (not closed to ak-roles:).
    git(wt, ["commit", "--allow-empty", "-m", "claude: docs lawful"]);
    git(wt, ["commit", "--allow-empty", "-m", "codex: fix lawful"]);
    git(wt, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} lawful`]);
    const afterGood = git(wt, ["rev-parse", "HEAD"]);
    assert.throws(
      () => git(wt, ["commit", "--allow-empty", "--amend", "-m", `${FACTORY_PREFIX} amended`]),
      /non-fast-forward|amend/i,
    );
    assert.equal(git(wt, ["rev-parse", "HEAD"]), afterGood);
    git(wt, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} forward`]);
    assert.notEqual(git(wt, ["rev-parse", "HEAD"]), afterGood);
    await writeFile(join(wt, "dirt.txt"), "dirty\n");
    git(wt, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} still ok dirty`]);

    // Unarmed main + sibling unconstrained (hook bound to armed worktree only).
    git(root, ["commit", "--allow-empty", "-m", "main unprefixed ok"]);
    git(sibling, ["commit", "--allow-empty", "-m", "sibling unprefixed ok"]);
    // Commander-style platform prefix on unarmed main must also pass (no hook).
    git(root, ["commit", "--allow-empty", "-m", "claude: commander on main"]);

    // Pre-existing unprefixed history must not be re-checked on ref creation.
    const seed = git(wt, ["rev-list", "--max-parents=0", "HEAD"]);
    git(wt, ["branch", "seed-alias", seed]);
    git(wt, ["checkout", "-b", "topic"]);
    git(wt, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} topic tip`]);
    git(wt, ["checkout", "-b", "integration", "seed-alias"]);
    git(wt, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} integration base`]);
    // Merge commits exempt from platform-prefix check (GitHub merge shape).
    git(wt, ["merge", "--no-ff", "-m", "Merge pull request #1 from topic", "topic"]);

    // Own-package prior hook body (marker present, content differs) must reload.
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
    // Reload must keep common clean.
    try {
      execFileSync("git", ["config", "--file", commonConfig, "--get", "core.hooksPath"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("common core.hooksPath must stay unset after reload");
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }

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
      const bareCommon = git(wtA, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      try {
        execFileSync("git", ["config", "--file", join(bareCommon, "config"), "--get", "core.hooksPath"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        assert.fail("bare-host common core.hooksPath must be unset");
      } catch (error) {
        assert.equal((error as { status?: number }).status, 1);
      }
      assert.throws(
        () => git(wtA, ["commit", "--allow-empty", "-m", "no prefix"]),
        /missing platform prefix/,
      );
      // Sibling never armed — unconstrained.
      git(wtB, ["commit", "--allow-empty", "-m", "sibling unprefixed ok on bare host"]);
      git(wtA, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} bare-host armed ok`]);
      git(wtA, ["commit", "--allow-empty", "-m", "claude: open prefix on bare-host armed"]);
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#355 migrate + install heal common hooksPath leak; single-clone main armable", async () => {
  // Real entry: migrateWorkerGitHookScope / installWorkerGitHooks.
  // Poison common core.hooksPath (live failure shape) → migrate clears → commander free;
  // install on linked tree keeps common clean; dedicated single-clone main may arm.
  const root = await tempGitRepo();
  try {
    const wt = join(root, "wt-355");
    git(root, ["worktree", "add", wt, "HEAD"]);
    const commonDir = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonConfig = join(commonDir, "config");
    const poisonDir = join(commonDir, "ak-roles-hooks");
    mkdirSync(poisonDir, { recursive: true });
    const poisonHook = join(poisonDir, "reference-transaction");
    writeFileSync(
      poisonHook,
      `#!/bin/sh
# ak-roles: worker-submission-gates reference-transaction
exit 1
`,
      "utf8",
    );
    chmodSync(poisonHook, 0o755);
    execFileSync("git", ["config", "--file", commonConfig, "core.hooksPath", poisonDir], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    // Main config.worktree also poisoned (live shape).
    git(root, ["config", "extensions.worktreeConfig", "true"]);
    git(root, ["config", "--worktree", "core.hooksPath", poisonDir]);

    // Common leak blocks even unprefixed commits on main (observed #355 damage).
    assert.throws(
      () => git(root, ["commit", "--allow-empty", "-m", "blocked by common leak"]),
      /./, // hook exit 1
    );

    migrateWorkerGitHookScope(wt);

    // Real observation: common hooksPath gone; poison dir removed; main free.
    try {
      execFileSync("git", ["config", "--file", commonConfig, "--get", "core.hooksPath"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("migrate must unset common core.hooksPath");
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }
    assert.equal(existsSync(poisonDir), false);
    git(root, ["commit", "--allow-empty", "-m", "claude: commander free after migrate"]);

    // Install arms linked tree only; common stays clean.
    installWorkerGitHooks(wt);
    try {
      execFileSync("git", ["config", "--file", commonConfig, "--get", "core.hooksPath"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("install must not write common core.hooksPath");
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }
    git(wt, ["commit", "--allow-empty", "-m", "claude: open ok after arm"]);
    git(root, ["commit", "--allow-empty", "-m", "still free on main"]);

    // Dedicated single-worktree clone: main is the worker workspace — armable.
    const solo = await tempGitRepo();
    try {
      installWorkerGitHooks(solo);
      const soloCommon = git(solo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      try {
        execFileSync("git", ["config", "--file", join(soloCommon, "config"), "--get", "core.hooksPath"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        assert.fail("solo common core.hooksPath must be unset");
      } catch (error) {
        assert.equal((error as { status?: number }).status, 1);
      }
      assert.equal(
        git(solo, ["config", "--worktree", "--get", "core.hooksPath"]),
        join(soloCommon, "ak-roles-hooks"),
      );
      git(solo, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} solo armed`]);
      assert.throws(
        () => git(solo, ["commit", "--allow-empty", "-m", "no prefix on solo"]),
        /missing platform prefix/,
      );
    } finally {
      await rm(solo, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#355 CLI migrate-worker-hooks is the operable entry; real git config observation", async () => {
  // Public entry only — not envelope arming. Poison common + sibling worktree hooksPath,
  // invoke ak-role migrate-worker-hooks, observe real git config clear.
  const root = await tempGitRepo();
  try {
    const wt = join(root, "wt-cli-migrate");
    const sibling = join(root, "wt-cli-sibling");
    git(root, ["worktree", "add", wt, "HEAD"]);
    git(root, ["worktree", "add", sibling, "HEAD"]);
    const commonDir = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonConfig = join(commonDir, "config");
    const poisonDir = join(commonDir, "ak-roles-hooks");
    mkdirSync(poisonDir, { recursive: true });
    writeFileSync(
      join(poisonDir, "reference-transaction"),
      `#!/bin/sh
# ak-roles: worker-submission-gates reference-transaction
exit 1
`,
      "utf8",
    );
    chmodSync(join(poisonDir, "reference-transaction"), 0o755);
    execFileSync("git", ["config", "--file", commonConfig, "core.hooksPath", poisonDir], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    // Sibling worktree-local binding (only migrate clears; install self-heal does not).
    git(sibling, ["config", "extensions.worktreeConfig", "true"]);
    const siblingGitDir = git(sibling, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const siblingPoison = join(siblingGitDir, "ak-roles-hooks");
    mkdirSync(siblingPoison, { recursive: true });
    writeFileSync(
      join(siblingPoison, "reference-transaction"),
      `#!/bin/sh
# ak-roles: worker-submission-gates reference-transaction
exit 1
`,
      "utf8",
    );
    chmodSync(join(siblingPoison, "reference-transaction"), 0o755);
    git(sibling, ["config", "--worktree", "core.hooksPath", siblingPoison]);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runAkRole(["migrate-worker-hooks", root], {
      packageRoot,
      home: process.env.HOME ?? "/tmp",
      io: {
        stdout: (t) => { stdout.push(t); },
        stderr: (t) => { stderr.push(t); },
      },
    });
    assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));
    assert.match(stdout.join(""), /migrated worker git hook scope/);

    // Real git config observation: common + sibling worktree bindings cleared.
    try {
      execFileSync("git", ["config", "--file", commonConfig, "--get", "core.hooksPath"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("CLI migrate must unset common core.hooksPath");
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }
    try {
      git(sibling, ["config", "--worktree", "--get", "core.hooksPath"]);
      assert.fail("CLI migrate must unset sibling worktree core.hooksPath");
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1);
    }
    assert.equal(existsSync(poisonDir), false);
    assert.equal(existsSync(siblingPoison), false);
    git(root, ["commit", "--allow-empty", "-m", "claude: free after CLI migrate"]);
    git(sibling, ["commit", "--allow-empty", "-m", "claude: sibling free after CLI migrate"]);

    // Discoverable via help registry.
    const helpOut: string[] = [];
    const help = await runAkRole(["help", "migrate-worker-hooks"], {
      packageRoot,
      home: process.env.HOME ?? "/tmp",
      io: {
        stdout: (t) => { helpOut.push(t); },
        stderr: () => undefined,
      },
    });
    assert.equal(help.exitCode, 0);
    assert.match(helpOut.join(""), /migrate-worker-hooks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#355 migrate fails loud on worktree list / per-worktree rev-parse errors", async () => {
  // Failure-honesty: silent return/continue would hollow the stale-entry purge guarantee.
  const root = await tempGitRepo();
  const bin = await mkdtemp(join(tmpdir(), "ak-git-shim-migrate-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const previousPath = process.env.PATH;
  try {
    const wt = join(root, "wt-fail-loud");
    git(root, ["worktree", "add", wt, "HEAD"]);

    // worktree list failure must throw (not silent return).
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = list ]; then
  echo "fatal: forced worktree list failure" >&2
  exit 128
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}${previousPath === undefined ? "" : `:${previousPath}`}`;
    assert.throws(
      () => migrateWorkerGitHookScope(wt),
      /cannot list worktrees/,
    );

    // per-worktree rev-parse failure must throw (not silent continue).
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if [ "$1" = rev-parse ] && printf '%s\n' "$*" | grep -q -- '--git-dir'; then
  # Allow the early inside-work-tree / common-dir probes; fail only git-dir of linked trees.
  case "$*" in
    *"--is-inside-work-tree"*|*".git"*|*"--git-common-dir"*) exec "${realGit}" "$@" ;;
  esac
  # Fail when cwd is a linked worktree path (not the main repo root).
  if [ "$(pwd)" != "${root}" ]; then
    echo "fatal: forced git-dir failure" >&2
    exit 128
  fi
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    assert.throws(
      () => migrateWorkerGitHookScope(wt),
      /cannot resolve worktree git-dir/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

test("#267 worktreeConfig enable is local-bool only: global true still enables; common yes skips shared write", async () => {
  // Real entry: installWorkerGitHooks. Two failure shapes, one bar:
  // (1) global true must not skip the repo's first enable;
  // (2) common value "yes" (Git bool) must skip shared write under config.lock.
  const root = await tempGitRepo();
  const globalConfig = join(await mkdtemp(join(tmpdir(), "ak-worker-gate-global-")), ".gitconfig");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    const wt = join(root, "wt-267");
    git(root, ["worktree", "add", wt, "HEAD"]);

    // Poison merged-scope reads: global true while local unset.
    writeFileSync(globalConfig, "[extensions]\n\tworktreeConfig = true\n");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    assert.equal(git(wt, ["config", "--get", "extensions.worktreeConfig"]), "true");
    assert.throws(() => git(wt, ["config", "--local", "--get", "extensions.worktreeConfig"]));

    // First arm must still write the repo's local/common config despite global true.
    installWorkerGitHooks(wt);
    assert.equal(git(wt, ["config", "--local", "--get", "extensions.worktreeConfig"]), "true");

    // Legitimate Git bool synonym in common config — must count as already enabled.
    git(wt, ["config", "--local", "extensions.worktreeConfig", "yes"]);
    assert.equal(git(wt, ["config", "--local", "--get", "extensions.worktreeConfig"]), "yes");

    const commonDir = git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const lockPath = join(commonDir, "config.lock");
    // Simulate sibling activation holding the shared lock (production race shape).
    writeFileSync(lockPath, "");
    try {
      assert.doesNotThrow(() => installWorkerGitHooks(wt));
      assert.equal(
        git(wt, ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"]),
        "true",
      );
    } finally {
      await rm(lockPath, { force: true });
    }
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await rm(root, { recursive: true, force: true });
    await rm(dirname(globalConfig), { recursive: true, force: true });
  }
});

test("#267 worktreeConfig bool read: only exit 1 continues; other get failures stay loud", async () => {
  // Real entry: installWorkerGitHooks. A poisoned extensions.worktreeConfig bricks every git
  // command (including the early rev-parse), so it cannot reach the bool-get catch. Shim only
  // the --local --bool --get to exit 128 while leaving the key unset — empty catch would
  // continue and write true; only exit 1 may mean unset.
  const root = await tempGitRepo();
  const bin = await mkdtemp(join(tmpdir(), "ak-git-shim-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(bin, "git");
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$1" = config ] && [ "$2" = --local ] && [ "$3" = --bool ] && [ "$4" = --get ] && [ "$5" = extensions.worktreeConfig ]; then
  echo "fatal: bad boolean config value 'notabool' for 'extensions.worktreeconfig'" >&2
  exit 128
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  const previousPath = process.env.PATH;
  try {
    const wt = join(root, "wt-267-bool");
    git(root, ["worktree", "add", wt, "HEAD"]);
    assert.throws(() => git(wt, ["config", "--local", "--get", "extensions.worktreeConfig"]));
    process.env.PATH = `${bin}${previousPath === undefined ? "" : `:${previousPath}`}`;
    assert.throws(
      () => installWorkerGitHooks(wt),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        if (!/bad boolean config value/i.test(error.message)) return false;
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? (error as { status: unknown }).status
            : undefined;
        return status === 128;
      },
    );
    process.env.PATH = previousPath;
    // Must remain unset — continuing after non-1 would have written true.
    assert.throws(() => git(wt, ["config", "--local", "--get", "extensions.worktreeConfig"]));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
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
    const gatePath = join(nest, files[0]!);
    const body = readFileSync(gatePath, "utf8");
    assert.match(body, new RegExp(WORKER_COMMIT_BASELINE_ENTRY_TYPE));
    assert.match(body, new RegExp(WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE));
    assert.match(body, new RegExp(baselineHead));

    // Advance HEAD after bounce — baseline must stay the first-arm tip across resume.
    git(project, ["commit", "--allow-empty", "-m", `${FACTORY_PREFIX} after bounce`]);

    // (a) same-nest second open on the live resume path: file identity + bytes unchanged.
    const bytesBefore = readFileSync(gatePath);
    const resumed = createWorkerSubmissionGate();
    resumed.arm(project, parent);
    const filesAfterResume = readdirSync(nest).filter((name) => name.endsWith(".jsonl"));
    assert.equal(filesAfterResume.length, 1);
    assert.equal(filesAfterResume[0], files[0]);
    assert.equal(
      Buffer.compare(bytesBefore, readFileSync(gatePath)),
      0,
      "same-nest second open must not rewrite existing gate file bytes",
    );
    // Fresh gate instance ≡ process resume: must not re-bounce; baseline still first tip.
    assert.doesNotThrow(() => resumed.assertAcceptable("completed"));

    // Ordinary no-subject children under the same parent must mint fresh sessions — never
    // reopen a sibling volume selected only by kind/cwd/mtime (S1 / ADR 0065 caller-identity).
    const evidenceA = createRecordSession({
      cwd: project,
      kind: "evidence-children",
      parent,
    });
    const evidenceAFile = evidenceA.getSessionFile();
    assert.ok(evidenceAFile, "first ordinary child must materialize a session file");
    evidenceA.appendCustomEntry("evidence-probe", { n: 1 });
    const evidenceB = createRecordSession({
      cwd: project,
      kind: "evidence-children",
      parent,
    });
    const evidenceBFile = evidenceB.getSessionFile();
    assert.ok(evidenceBFile, "second ordinary child must materialize its own session file");
    assert.notEqual(
      evidenceBFile,
      evidenceAFile,
      "later ordinary child under same parent must not reopen the prior sibling volume",
    );
    const auditorA = createRecordSession({ cwd: project, kind: "auditor-roles", parent });
    const auditorB = createRecordSession({ cwd: project, kind: "auditor-roles", parent });
    assert.notEqual(
      auditorA.getSessionFile(),
      auditorB.getSessionFile(),
      "later auditor-roles child under same parent must not reopen the prior sibling volume",
    );

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

    // (b) first entry materializes → chmod 444 → same-nest second entry reopen →
    // real worker output tool append fails with EACCES through production hostActions +
    // tool_result overlay under shared Pi harness; public CLI settles terminal failure.
    const projectF = join(home, "proj-f-eacces");
    await mkdir(projectF, { recursive: true });
    seedGitRepository(projectF);
    git(projectF, ["config", "user.email", "gate@test.local"]);
    git(projectF, ["config", "user.name", "Gate Test"]);
    git(projectF, ["commit", "--allow-empty", "-m", "seed-f"]);

    const callIdF = "fixer-eacces";
    const completed = {
      status: "completed" as const,
      report: "done",
      classResults: [{
        name: "Contract",
        disposition: "completed" as const,
        searchScope: "all",
        exceptions: [] as Array<{ where: string; reason: string }>,
        commitSha: "a".repeat(40),
      }],
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    // Real hostActions may stamp json-mode exitCode; scrub so the file runner stays clean.
    // Public nonzero proof is runAkRole.exitCode below, not this process stamp.
    const prevExitF = process.exitCode;
    process.exitCode = undefined;
    let result: Awaited<ReturnType<typeof runAkRole>>;
    try {
      const agentDirF = join(home, ".pi-agent-eacces");
      await mkdir(agentDirF, { recursive: true });
      result = await runAkRole(
        ["fixer", "--project", projectF, "Exercise gate EACCES durability."],
        {
          packageRoot,
          home,
          agentDir: agentDirF,
          cwd: projectF,
          createRunId: () => "run-gate-eacces-001",
          io: {
            stdout: (text: string) => { stdout.push(text); },
            stderr: (text: string) => { stderr.push(text); },
          },
          piRunner: async (args, options) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            const packetPath = args[args.indexOf("--ak-fix-packet") + 1]!;
            const agentDir = typeof options.env.PI_CODING_AGENT_DIR === "string"
              ? options.env.PI_CODING_AGENT_DIR
              : agentDirF;

            // First production entry via real gate/sitian API (fixture constructs nest facts).
            const parentF = SessionManager.open(sessionFile, sessionDir, projectF);
            createWorkerSubmissionGate().arm(projectF, parentF);
            const nestF = join(dirname(sessionFile), WORKER_SUBMISSION_GATE_RECORD_KIND);
            const filesF = readdirSync(nestF).filter((name) => name.endsWith(".jsonl"));
            assert.equal(filesF.length, 1, "first entry must materialize one gate record");
            chmodSync(join(nestF, filesF[0]!), 0o444);

            // Second production entry: session_start re-arms same nest, then worker tool append.
            const faux = fauxProvider({
              api: "ak-gate-eacces",
              provider: "ak-gate-eacces",
              tokenSize: { min: 1000, max: 1000 },
            });
            faux.setResponses([
              fauxAssistantMessage(
                fauxToolCall(FIXER_OUTPUT_TOOL_NAME, completed, { id: callIdF }),
                { stopReason: "toolUse" },
              ),
            ]);
            await withInProcessPi({
              cwd: projectF,
              agentDir,
              faux,
              sessionManager: SessionManager.open(sessionFile, sessionDir, projectF),
              additionalExtensionPaths: [resolvePackageEntrypoint()],
              systemPrompt: "GATE EACCES DURABILITY",
              mode: "json",
              flags: {
                "ak-role": "fixer",
                "ak-fixer-phase": "apply",
                "ak-fix-packet": packetPath,
              },
              noTools: "builtin",
              // Drain production session_shutdown so Navigator attendance timers do not pin the runner.
              reviewerShutdown: true,
            }, async ({ session }) => {
              await session.prompt("Exercise gate EACCES durability.").catch(() => undefined);
            });
            return {
              code: typeof process.exitCode === "number" ? process.exitCode : 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
    } finally {
      process.exitCode = prevExitF;
    }

    assert.equal(result.exitCode, 1, stdout.join("") || stderr.join("") || "public CLI must exit nonzero");
    assert.ok(result.terminal, "public CLI must settle a terminal result");
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(result.terminal!.roleOutcome.cause, "output");
      assert.match(result.terminal!.roleOutcome.diagnostic, /EACCES/);
      // Public settlement retains the closed infra fact and stamps process exit as exitCode
      // (#307: exitCode = process exit; code = remote/upstream only when testimony exists).
      assert.deepEqual(result.terminal!.roleOutcome.decisiveFacts.secondaryEvidence, {
        ...buildNavigatorInfrastructureFailureFact(),
        exitCode: 1,
      });
      assert.equal(result.terminal!.roleOutcome.decisiveFacts.errorName, FIXER_OUTPUT_TOOL_NAME);
      assert.equal(result.terminal!.roleOutcome.decisiveFacts.errorCode, callIdF);
    }
  });
});
