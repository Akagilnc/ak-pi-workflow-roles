import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
// #685 C1: withInProcessPi/createAgentSession host legs culled; production dossiers succeed.
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/** #369 submission-seam gates ①② + upgrade uninstall — real arm/assertAcceptable entry. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createRecordSession } from "../../src/archivist-record-entry.ts";
import {
  createWorkerSubmissionGate,
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
  WORKER_COMMIT_BASELINE_ENTRY_TYPE,
  WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE,
  WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE,
  WORKER_SUBMISSION_GATE_RECORD_KIND,
} from "../../src/worker-submission-gates.ts";
import {
  machineLedgerHome,
  packageRoot,
  resolvePackageEntrypoint,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
const FACTORY = "ak-roles:";
const OWNED_MARKER = "ak-roles: worker-submission-gates reference-transaction";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureGitUser(cwd: string): void {
  git(cwd, ["config", "user.email", "gate@test.local"]);
  git(cwd, ["config", "user.name", "Gate Test"]);
}

/**
 * #604: bare arm keeps in-memory bounce (no parent) but sitian must not fall
 * through to the real machine home. Fixture owns a temp package home and passes
 * it into createWorkerSubmissionGate({ home }) — explicit injection, not post-rm.
 */
async function withTempGit<T>(
  fn: (root: string, home: string) => Promise<T> | T,
  options?: { seed?: boolean },
): Promise<T> {
  const home = await mkdtemp(worktreeTempPrefix("ak-worker-gate-home-"));
  const root = await mkdtemp(join(home, "repo-"));
  git(root, ["init", "-b", "main"]);
  configureGitUser(root);
  if (options?.seed !== false) git(root, ["commit", "--allow-empty", "-m", "seed"]);
  try {
    return await fn(root, home);
  } finally {
    // home owns the nested repo root; reclaim the outer owned root.
    await rm(home, { recursive: true, force: true });
  }
}

function bareGate(home: string) {
  return createWorkerSubmissionGate({ home });
}

function plantOwnedHooks(cwd: string): { hooksDir: string; hookPath: string } {
  git(cwd, ["config", "extensions.worktreeConfig", "true"]);
  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const hooksDir = join(gitDir, "ak-roles-hooks");
  const hookPath = join(hooksDir, "reference-transaction");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, `#!/bin/sh\n# ${OWNED_MARKER}\nexit 0\n`, "utf8");
  chmodSync(hookPath, 0o755);
  git(cwd, ["config", "--worktree", "core.hooksPath", hooksDir]);
  return { hooksDir, hookPath };
}

function hooksPathOf(cwd: string): string | undefined {
  try {
    return git(cwd, ["config", "--get", "core.hooksPath"]);
  } catch {
    return undefined;
  }
}

function hooksPathsOf(cwd: string): string[] {
  try {
    const out = git(cwd, ["config", "--get-all", "core.hooksPath"]);
    return out.length === 0 ? [] : out.split("\n");
  } catch {
    return [];
  }
}

async function scrubPlanted(
  cwd: string,
  planted: { hooksDir: string; hookPath: string },
): Promise<void> {
  chmodSync(planted.hookPath, 0o755);
  chmodSync(planted.hooksDir, 0o755);
  try {
    git(cwd, ["config", "--worktree", "--unset", "core.hooksPath"]);
  } catch {
    /* already clear */
  }
}

function armThenCommit(cwd: string, home: string, message: string) {
  const gate = bareGate(home);
  gate.arm(cwd);
  git(cwd, ["commit", "--allow-empty", "-m", message]);
  return gate;
}

function soleGateRecordPath(parentOrNest: SessionManager | string): string {
  const nest = typeof parentOrNest === "string"
    ? parentOrNest
    : join(dirname(parentOrNest.getSessionFile()!), WORKER_SUBMISSION_GATE_RECORD_KIND);
  const files = readdirSync(nest).filter((n) => n.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  return join(nest, files[0]!);
}

test("unfinished reason gate bounces missing reason up to twice then accepts; reasoned unfinished free; other statuses unchanged", () => {
  const gate = createWorkerSubmissionGate();
  assert.throws(
    () => gate.assertAcceptable("unfinished", {}),
    (error: unknown) =>
      error instanceof WorkerUnfinishedReasonReminderError &&
      error.code === "worker_unfinished_reason_reminder",
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
  await withTempGit(async (root, home) => {
    // bare non-git arm target must sit outside this worktree's upward Git discovery;
    // /tmp named root is not deleted (owner 2026-09-06 directory boundary).
    const bare = await mkdtemp(join("/tmp", "ak-worker-gate-bare-"));
    const gate = bareGate(home);
    gate.arm(root);
    for (const status of ["planned", "refused"] as const) {
      assert.doesNotThrow(() => gate.assertAcceptable(status), status);
    }
    assert.doesNotThrow(() =>
      gate.assertAcceptable("unfinished", { reason: "unconstitutional: task contradicts ADR 0055" }),
    );
    assert.throws(
      () => gate.assertAcceptable("completed"),
      (error: unknown) =>
        error instanceof WorkerCommitReminderError &&
        error.code === "worker_commit_reminder",
    );
    assert.doesNotThrow(() => gate.assertAcceptable("completed"));
    const g2 = bareGate(home);
    g2.arm(root);
    assert.throws(() => g2.assertAcceptable("partially_completed"), WorkerCommitReminderError);
    git(root, ["commit", "--allow-empty", "-m", `${FACTORY} work`]);
    assert.doesNotThrow(() => armThenCommit(root, home, `${FACTORY} more`).assertAcceptable("completed"));

    assert.throws(() => bareGate(home).arm(bare), /not a git repository/);

    await withTempGit(async (unborn, unbornHome) => {
      const g = bareGate(unbornHome);
      g.arm(unborn);
      assert.throws(() => g.assertAcceptable("completed"), WorkerCommitReminderError);
    }, { seed: false });
  });
});

test("② missing prefix bounces once then confirm; open set + merge exempt; unreliable window skipped; status matrix free", async () => {
  await withTempGit(async (root, home) => {
    const missing = armThenCommit(root, home, "forgot the platform prefix");
    assert.throws(
      () => missing.assertAcceptable("completed"),
      (error: unknown) =>
        error instanceof WorkerPrefixReminderError &&
        error.code === "worker_prefix_reminder",
    );
    assert.doesNotThrow(() => missing.assertAcceptable("completed"));

    // Open set: not ak-roles: singleton; no conventional-type blacklist.
    for (const subject of [
      "claude: docs lawful open prefix",
      "feat: conventional type is not blacklisted",
      `${FACTORY} factory sample`,
    ]) {
      assert.doesNotThrow(
        () => armThenCommit(root, home, subject).assertAcceptable("completed"),
        subject,
      );
    }

    // Merge commit exempt (GitHub merge shape, unprefixed subject).
    await withTempGit(async (mergeRepo, mergeHome) => {
      const g = bareGate(mergeHome);
      g.arm(mergeRepo);
      git(mergeRepo, ["checkout", "-b", "topic"]);
      git(mergeRepo, ["commit", "--allow-empty", "-m", `${FACTORY} topic tip`]);
      git(mergeRepo, ["checkout", "main"]);
      git(mergeRepo, ["commit", "--allow-empty", "-m", `${FACTORY} main tip`]);
      git(mergeRepo, ["merge", "--no-ff", "-m", "Merge pull request #1 from topic", "topic"]);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    });

    // planned / refused / unfinished never fire gate ②.
    const free = armThenCommit(root, home, "still missing prefix");
    assert.doesNotThrow(() => free.assertAcceptable("planned"));
    assert.doesNotThrow(() => free.assertAcceptable("refused"));
    assert.doesNotThrow(() =>
      free.assertAcceptable("unfinished", { reason: "prerequisite_missing: owner decision" }),
    );

    // baseline tip not ancestor of HEAD → unreliable → no prefix bounce.
    await withTempGit(async (unrelated, unrelatedHome) => {
      const g = bareGate(unrelatedHome);
      g.arm(unrelated);
      git(unrelated, ["checkout", "--orphan", "other"]);
      git(unrelated, ["commit", "--allow-empty", "-m", "orphan tip without prefix"]);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    });

    // Unborn positive: null baseline → first unprefixed commit → bounce once → confirm.
    await withTempGit(async (unbornPos, unbornHome) => {
      const g = armThenCommit(unbornPos, unbornHome, "first commit no prefix");
      assert.throws(() => g.assertAcceptable("completed"), WorkerPrefixReminderError);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    }, { seed: false });

    // Unborn negative: zero commits → gate ① only.
    await withTempGit(async (unbornNeg, unbornHome) => {
      const g = bareGate(unbornHome);
      g.arm(unbornNeg);
      assert.throws(() => g.assertAcceptable("completed"), WorkerCommitReminderError);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    }, { seed: false });
  });
});

test("arm stops writing hooks and idempotently uninstalls package-owned traces only", async () => {
  await withTempGit(async (root, home) => {
    await withTempGit(async (stranger, _strangerHome) => {
      const beforeLocal = git(root, ["config", "--local", "--list"]);
      bareGate(home).arm(root);
      assert.equal(git(root, ["config", "--local", "--list"]), beforeLocal);
      assert.equal(hooksPathOf(root), undefined);
      const gitDir = git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
      assert.equal(existsSync(join(gitDir, "ak-roles-hooks")), false);

      const { hooksDir, hookPath } = plantOwnedHooks(root);
      assert.ok(existsSync(hookPath));
      const worktreeConfigBefore = git(root, ["config", "--local", "--get", "extensions.worktreeConfig"]);
      bareGate(home).arm(root);
      assert.equal(hooksPathOf(root), undefined);
      assert.equal(existsSync(hooksDir), false);
      assert.equal(git(root, ["config", "--local", "--get", "extensions.worktreeConfig"]), worktreeConfigBefore);
      assert.doesNotThrow(() => bareGate(home).arm(root));

      // Unmarked same-named dir must survive; hooksPath to non-owned dir stays.
      const foreignDir = join(gitDir, "ak-roles-hooks");
      const foreignHook = join(foreignDir, "reference-transaction");
      mkdirSync(foreignDir, { recursive: true });
      writeFileSync(foreignHook, "#!/bin/sh\n# foreign hook body\nexit 0\n", "utf8");
      git(root, ["config", "extensions.worktreeConfig", "true"]);
      git(root, ["config", "--worktree", "core.hooksPath", foreignDir]);
      bareGate(home).arm(root);
      assert.ok(existsSync(foreignHook), "unmarked same-named dir must survive");
      assert.equal(hooksPathOf(root), foreignDir);
      git(root, ["config", "--worktree", "--unset", "core.hooksPath"]);

      // Mixed dir: owned hook + unmarked sibling → clear hooksPath, drop owned file only;
      // foreign sibling and the non-empty directory must survive (ownership boundary).
      const mixed = plantOwnedHooks(root);
      const sibling = join(mixed.hooksDir, "user-extra-hook");
      writeFileSync(sibling, "#!/bin/sh\n# not package-owned\nexit 0\n", "utf8");
      bareGate(home).arm(root);
      assert.equal(hooksPathOf(root), undefined);
      assert.equal(existsSync(mixed.hookPath), false, "owned hook file must be removed");
      assert.ok(existsSync(sibling), "unmarked sibling file must survive");
      assert.ok(existsSync(mixed.hooksDir), "non-empty hooks dir must survive");

      // Multi-valued core.hooksPath: drop only owned matching values; keep all foreign.
      // Plain --unset exit 5 is multi-value OR absent — must not leave stale owned config.
      const multiOwned = plantOwnedHooks(root);
      const foreignMultiDir = join(gitDir, "foreign-hooks-multi");
      const foreignMultiHook = join(foreignMultiDir, "reference-transaction");
      mkdirSync(foreignMultiDir, { recursive: true });
      writeFileSync(foreignMultiHook, "#!/bin/sh\n# foreign multi value\nexit 0\n", "utf8");
      git(root, ["config", "--worktree", "--add", "core.hooksPath", foreignMultiDir]);
      assert.deepEqual(
        new Set(hooksPathsOf(root)),
        new Set([multiOwned.hooksDir, foreignMultiDir]),
        "precondition: owned + foreign multi-value hooksPath",
      );
      bareGate(home).arm(root);
      assert.deepEqual(
        hooksPathsOf(root),
        [foreignMultiDir],
        "only foreign hooksPath value(s) must remain",
      );
      assert.equal(existsSync(multiOwned.hookPath), false, "owned hook file must be removed");
      assert.ok(existsSync(foreignMultiHook), "foreign multi-value target must survive");
      git(root, ["config", "--worktree", "--unset-all", "core.hooksPath"]);

      // Migrated core.bare / core.worktree stay (real path — fake path bricks git).
      const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const mainWtConfig = join(commonDir, "config.worktree");
      writeFileSync(mainWtConfig, `[core]\n\tbare = false\n\tworktree = ${root}\n`, "utf8");
      plantOwnedHooks(root);
      bareGate(home).arm(root);
      const preserved = readFileSync(mainWtConfig, "utf8");
      assert.match(preserved, /bare\s*=\s*false/);
      assert.ok(preserved.includes(`worktree = ${root}`));
      assert.doesNotMatch(preserved, /hooksPath/);

      // Linked worktree owned hooks cleared with served repo.
      const wt = join(root, "wt-linked");
      git(root, ["worktree", "add", wt, "HEAD"]);
      const plantedWt = plantOwnedHooks(wt);
      bareGate(home).arm(root);
      assert.equal(hooksPathOf(wt), undefined);
      assert.equal(existsSync(plantedWt.hooksDir), false);

      // Symlinked worktree admin entry must not be followed — external target stays intact.
      const plantedStranger = plantOwnedHooks(stranger);
      const strangerGitDir = git(stranger, ["rev-parse", "--path-format=absolute", "--git-dir"]);
      const worktreesRoot = join(commonDir, "worktrees");
      mkdirSync(worktreesRoot, { recursive: true });
      const escapeLink = join(worktreesRoot, "symlink-escape");
      symlinkSync(strangerGitDir, escapeLink);
      try {
        bareGate(home).arm(root);
        assert.equal(
          hooksPathOf(stranger),
          plantedStranger.hooksDir,
          "symlink worktree entry must not clear external hooksPath",
        );
        assert.ok(
          existsSync(plantedStranger.hookPath),
          "symlink worktree entry must not delete external owned hook",
        );
      } finally {
        unlinkSync(escapeLink);
      }

      // Unrelated repo out of discoverable range (no symlink entry).
      bareGate(home).arm(root);
      assert.equal(hooksPathOf(stranger), plantedStranger.hooksDir);
      assert.ok(existsSync(plantedStranger.hookPath));

      // Failure honesty: unreadable owned hook must not be washed into "not owned".
      const unreadable = plantOwnedHooks(root);
      chmodSync(unreadable.hookPath, 0o000);
      try {
        assert.throws(() => bareGate(home).arm(root), /EACCES|permission denied/i);
        assert.equal(
          hooksPathOf(root),
          unreadable.hooksDir,
          "failed uninstall must not clear hooksPath after disguising ownership",
        );
      } finally {
        await scrubPlanted(root, unreadable);
      }

      // Failure honesty: delete failure must surface; arm must not continue as success.
      const undeletable = plantOwnedHooks(root);
      chmodSync(undeletable.hooksDir, 0o555);
      try {
        assert.throws(() => bareGate(home).arm(root), /EACCES|permission denied/i);
      } finally {
        await scrubPlanted(root, undeletable);
      }
    });
  });
});
