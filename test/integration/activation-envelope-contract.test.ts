import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import {
  ActivationGitRepositoryRequiredError,
  durableSessionPointer,
  resolveBookKeyFromGit,
} from "../../src/role-runtime.ts";
import {
  activationBookKeyFor,
  machineLedgerHome,
  persistActivationSessionFile,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";
import { outsideWorktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";


const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

test("book key follows git common-dir host basename across worktrees, rename, and basename collision", async () => {
  return await withTempRoot("ak-book-topo-", async (root) => {
    const main = join(root, "project-alpha");
    mkdirSync(main);
    execFileSync("git", ["init", "-b", "main"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: main,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const worktree = join(root, "project-alpha-wt");
    execFileSync("git", ["worktree", "add", worktree], { cwd: main, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(main), "project-alpha");
    assert.equal(resolveBookKeyFromGit(worktree), "project-alpha");

    const renamed = join(root, "project-beta");
    renameSync(main, renamed);
    assert.equal(resolveBookKeyFromGit(renamed), "project-beta");

    const twin = join(root, "collision", "project-beta");
    mkdirSync(join(root, "collision"), { recursive: true });
    mkdirSync(twin);
    execFileSync("git", ["init", "-b", "main"], { cwd: twin, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(twin), "project-beta");
    assert.equal(resolveBookKeyFromGit(renamed), resolveBookKeyFromGit(twin));

    // Non-git cwd must loudly reject even when GIT_DIR points at another repository.
    // Isolation root must sit outside this worktree's upward Git discovery; outside
    // named root is not deleted (owner 2026-09-06 directory boundary).
    const nonGit = mkdtempSync(outsideWorktreeTempPrefix("ak-book-topo-nongit-"));
    const previousGitDir = process.env.GIT_DIR;
    const previousGitCommon = process.env.GIT_COMMON_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_DIR = join(renamed, ".git");
      process.env.GIT_COMMON_DIR = join(renamed, ".git");
      process.env.GIT_WORK_TREE = renamed;
      assert.throws(
        () => resolveBookKeyFromGit(nonGit),
        (error: unknown) => {
          assert.ok(error instanceof ActivationGitRepositoryRequiredError);
          assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
          assert.ok(error.cause !== undefined, "original git cause must be retained");
          return true;
        },
      );
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousGitCommon === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previousGitCommon;
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousGitWorkTree;
    }
    });
});

test("git spawn infrastructure failures retain identity and do not masquerade as non-git", async () => {
  return await withTempRoot("ak-book-infra-", async (root) => {
    // Non-git control cwd must sit outside this worktree; outside named root is not deleted.
    // Second acquire stays inside try so a failure still hits root's finally.
    const nonGitCwd = mkdtempSync(outsideWorktreeTempPrefix("ak-book-infra-nongit-"));
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    // Empty PATH makes spawn of `git` fail with ENOENT — infrastructure, not non-git cwd.
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = emptyBin;
      assert.throws(
        () => resolveBookKeyFromGit(cwd),
        (error: unknown) => {
          assert.equal(
            error instanceof ActivationGitRepositoryRequiredError,
            false,
            "ENOENT must not become ActivationGitRepositoryRequiredError",
          );
          assert.ok(error !== null && typeof error === "object" && "code" in error);
          assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    // Control: a real git child that exits nonzero remains the typed non-git error.
    assert.throws(
      () => resolveBookKeyFromGit(nonGitCwd),
      (error: unknown) => {
        assert.ok(error instanceof ActivationGitRepositoryRequiredError);
        assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
        assert.ok(error.cause !== undefined);
        const cause = error.cause as { status?: unknown };
        assert.equal(typeof cause.status, "number");
        assert.notEqual(cause.status, 0);
        return true;
      },
    );
    });
});

// #855: waiting.jsonl append + symlink-escape matrix deleted with two-face reconciliation.
// ADR 0065 principal admission (activation does not police record placement) stays.
test("durable session principal admits escaped realpath without placement lock", async () => {
  await withActivationHome({ prefix: "ak-act-symlink-" }, async ({ home }) => {
    const bookKey = activationBookKeyFor(home);
    const ledgerHome = machineLedgerHome(home);
    const sessionFile = persistActivationSessionFile({ home, bookKey, cwd: home });
    const realSession = resolve(sessionFile);
    const bookDir = join(ledgerHome, "books", bookKey);
    const runsDir = join(bookDir, "runs");
    const decoyDir = join(home, "decoy-runs", "activation", "default");
    mkdirSync(dirname(decoyDir), { recursive: true });
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(decoyDir, { recursive: true });
    const decoyFile = join(decoyDir, "session.jsonl");
    writeFileSync(
      decoyFile,
      `${JSON.stringify({ type: "session", version: 3, id: "decoy", timestamp: "2025-01-01T00:00:00.000Z", cwd: home })}\n`,
    );
    symlinkSync(join(home, "decoy-runs"), runsDir);
    const pointer = durableSessionPointer({
      getSessionFile: () => join(runsDir, "activation", "default", "session.jsonl"),
    });
    assert.equal(pointer.kind, "session-file");
    assert.equal(pointer.path, realpathSync(decoyFile));
    assert.notEqual(realSession, decoyFile);
  });
});
