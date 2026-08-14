/**
 * #337 taishi public CLI sweep mode — caller-invoked normal CLI (ADR 0052 / ADR 0068).
 *
 * Input carrier = exactly one typed JSON attachment (--attach); fields 1:1 with
 * TaishiSweepModeInput. argv/stdin do not carry sweep payload.
 * Positive: attach merged-PR list+LOC → pages+index match library runTaishi oracle.
 * Negative: 0/>1 attach, non-UTF-8/JSON fail, field contract fail → typed reject + zero writes.
 * Reuses #336 envelope and #329 sweep kernel (no second compute kernel).
 * Fixture identity: runId segment reservation 7xxx (no new ledger runs; reuse C1 boards).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import {
  taishiLibraryIndexPath,
  type TaishiLibraryIndexPage,
} from "../../src/taishi-index.ts";
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

/** Shared board — hand-known legs (C1/B-wave). */
const ISSUE_DEMO = "/taishi-fixture/issue-demo";
/** C1 alpha — wall 40_000. */
const ISSUE_ALPHA = "/taishi-fixture/c1-issue-alpha";
/** C1 beta — wall 10_000. */
const ISSUE_BETA = "/taishi-fixture/c1-issue-beta";

const DEMO_TOTAL_ELAPSED_MS = 302_000;
const ALPHA_TOTAL_ELAPSED_MS = 40_000;
const BETA_TOTAL_ELAPSED_MS = 10_000;
const ALPHA_LAST_ACTIVITY_AT = "2026-08-02T00:00:40.000Z";

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-337-business-"));
  try {
    execFileSync("git", ["init"], { cwd: businessRepo });
    await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: businessRepo },
    );
    assert.equal(gitPorcelain(businessRepo), "", "business repo starts clean");
    const result = await fn(businessRepo);
    assert.equal(gitPorcelain(businessRepo), "", "business repo zero write");
    return result;
  } finally {
    await rm(businessRepo, { recursive: true, force: true });
  }
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "taishi-337-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

/** Recursive taishi-dir snapshot for zero-write oracle (path → file bytes). */
async function snapshotTaishiDir(ledgerHome: string): Promise<Map<string, string>> {
  const root = join(ledgerHome, "taishi");
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return;
      }
      throw error;
    }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const childPath = join(dir, name);
      const info = await stat(childPath);
      if (info.isDirectory()) {
        await walk(childPath, childRel);
        continue;
      }
      out.set(childRel, await readFile(childPath, "utf8"));
    }
  }
  await walk(root, "");
  return out;
}

function assertSnapshotsEqual(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [key, bytes] of before) {
    assert.equal(after.get(key), bytes, `taishi file changed: ${key}`);
  }
}

async function writeSweepAttachment(
  dir: string,
  name: string,
  body: string | Buffer,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

const VALID_SWEEP_INPUT = {
  mode: "sweep" as const,
  mergedPullRequests: [
    { projectRoot: ISSUE_DEMO, changedLines: 0 },
    { projectRoot: ISSUE_ALPHA, changedLines: 500 },
    { projectRoot: ISSUE_BETA },
  ],
};

test("taishi public CLI sweep: one typed attach → pages+index match runTaishi oracle", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Attachments live outside the business repo (caller-owned input path).
      const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
      try {
        const attachPath = await writeSweepAttachment(
          attachDir,
          "sweep-input.json",
          `${JSON.stringify(VALID_SWEEP_INPUT)}\n`,
        );

        const oracle = await runTaishi(VALID_SWEEP_INPUT);
        // Reset pages written by oracle so CLI path is the sole writer under test.
        await rm(join(ledgerHome, "taishi"), { recursive: true, force: true });

        const { io, stdout, stderr } = captureIo();
        const result = await runAkRole(
          ["taishi", "--attach", attachPath],
          { packageRoot, home, io },
        );

        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(stderr.join(""), "");

        const receipt = JSON.parse(stdout.join("")) as {
          mode: string;
          issuePages: readonly { page: TaishiIssueMetricsPage }[];
          index: TaishiLibraryIndexPage;
          indexPath: string;
        };
        assert.equal(receipt.mode, "sweep");
        assert.equal(receipt.issuePages.length, 3);
        assert.deepEqual(
          receipt.issuePages.map((p) => p.page),
          oracle.issuePages.map((p) => p.page),
        );
        assert.deepEqual(receipt.index, oracle.index);
        assert.equal(receipt.indexPath, taishiLibraryIndexPath(ledgerHome));

        // Disk pages match oracle hand values (LOC present/absent).
        const alphaPage = JSON.parse(
          await readFile(taishiIssuePagePath(ledgerHome, ISSUE_ALPHA), "utf8"),
        ) as TaishiIssueMetricsPage;
        assert.equal(alphaPage.totalElapsedMs, ALPHA_TOTAL_ELAPSED_MS);
        assert.deepEqual(alphaPage.changedLines, { status: "present", value: 500 });
        assert.deepEqual(alphaPage.msPerKLines, { status: "present", value: 80_000 });
        assert.deepEqual(alphaPage.lastActivityAt, {
          status: "present",
          at: ALPHA_LAST_ACTIVITY_AT,
        });
        assert.equal(alphaPage.projectRoot, physicalPathIdentity(ISSUE_ALPHA));

        const demoPage = JSON.parse(
          await readFile(taishiIssuePagePath(ledgerHome, ISSUE_DEMO), "utf8"),
        ) as TaishiIssueMetricsPage;
        assert.equal(demoPage.totalElapsedMs, DEMO_TOTAL_ELAPSED_MS);
        assert.deepEqual(demoPage.changedLines, { status: "absent" });

        const betaPage = JSON.parse(
          await readFile(taishiIssuePagePath(ledgerHome, ISSUE_BETA), "utf8"),
        ) as TaishiIssueMetricsPage;
        assert.equal(betaPage.totalElapsedMs, BETA_TOTAL_ELAPSED_MS);
        assert.deepEqual(betaPage.changedLines, { status: "absent" });

        const indexOnDisk = JSON.parse(
          await readFile(taishiLibraryIndexPath(ledgerHome), "utf8"),
        ) as TaishiLibraryIndexPage;
        assert.deepEqual(indexOnDisk, oracle.index);
      } finally {
        await rm(attachDir, { recursive: true, force: true });
      }
    });
  });
});

test("taishi public CLI sweep reject: no attachment → typed usage + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);

      const { io, stderr } = captureIo();
      // Sweep mode selected by positional token without --attach.
      const result = await runAkRole(["taishi", "sweep"], {
        packageRoot,
        home,
        io,
      });

      assert.equal(result.exitCode, 2);
      const err = stderr.join("");
      assert.match(err, /^ak-role: /);
      assert.match(err, /attach/i);
      assert.match(err, /exactly one|one attachment|attachment/i);

      const after = await snapshotTaishiDir(ledgerHome);
      assertSnapshotsEqual(before, after);
    });
  });
});

test("taishi public CLI sweep reject: multiple attachments → typed + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);
      const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
      try {
        const a = await writeSweepAttachment(
          attachDir,
          "sweep-a.json",
          `${JSON.stringify(VALID_SWEEP_INPUT)}\n`,
        );
        const b = await writeSweepAttachment(
          attachDir,
          "sweep-b.json",
          `${JSON.stringify(VALID_SWEEP_INPUT)}\n`,
        );

        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["taishi", "--attach", a, "--attach", b],
          { packageRoot, home, io },
        );

        assert.equal(result.exitCode, 2);
        const err = stderr.join("");
        assert.match(err, /^ak-role: /);
        assert.match(err, /attach/i);
        assert.match(err, /exactly one|one attachment/i);

        const after = await snapshotTaishiDir(ledgerHome);
        assertSnapshotsEqual(before, after);
      } finally {
        await rm(attachDir, { recursive: true, force: true });
      }
    });
  });
});

test("taishi public CLI sweep reject: non-UTF-8 attachment → typed + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);
      const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
      try {
        // Invalid UTF-8 sequence (lone continuation byte).
        const bad = await writeSweepAttachment(
          attachDir,
          "sweep-bad-utf8.json",
          Buffer.from([0x7b, 0x80, 0x7d]),
        );

        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["taishi", "--attach", bad],
          { packageRoot, home, io },
        );

        assert.equal(result.exitCode, 2);
        const err = stderr.join("");
        assert.match(err, /^ak-role: /);
        assert.match(err, /utf-8/i);

        const after = await snapshotTaishiDir(ledgerHome);
        assertSnapshotsEqual(before, after);
      } finally {
        await rm(attachDir, { recursive: true, force: true });
      }
    });
  });
});

test("taishi public CLI sweep reject: JSON parse failure → typed + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);
      const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
      try {
        const bad = await writeSweepAttachment(
          attachDir,
          "sweep-not-json.json",
          "{ not json\n",
        );

        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["taishi", "--attach", bad],
          { packageRoot, home, io },
        );

        assert.equal(result.exitCode, 2);
        const err = stderr.join("");
        assert.match(err, /^ak-role: /);
        assert.match(err, /json/i);

        const after = await snapshotTaishiDir(ledgerHome);
        assertSnapshotsEqual(before, after);
      } finally {
        await rm(attachDir, { recursive: true, force: true });
      }
    });
  });
});

test("taishi public CLI sweep reject: field contract fail → typed + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);
      const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
      try {
        const cases: readonly { name: string; body: unknown }[] = [
          {
            name: "missing-mode.json",
            body: { mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }] },
          },
          {
            name: "extra-top-field.json",
            body: {
              mode: "sweep",
              mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }],
              extra: true,
            },
          },
          {
            name: "wrong-mode.json",
            body: {
              mode: "issue",
              mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }],
            },
          },
          {
            name: "entry-extra-field.json",
            body: {
              mode: "sweep",
              mergedPullRequests: [
                { projectRoot: ISSUE_ALPHA, issueNumber: 7 },
              ],
            },
          },
          {
            name: "entry-bad-changedLines.json",
            body: {
              mode: "sweep",
              mergedPullRequests: [
                { projectRoot: ISSUE_ALPHA, changedLines: "500" },
              ],
            },
          },
        ];

        for (const entry of cases) {
          const path = await writeSweepAttachment(
            attachDir,
            entry.name,
            `${JSON.stringify(entry.body)}\n`,
          );
          const { io, stderr } = captureIo();
          const result = await runAkRole(
            ["taishi", "--attach", path],
            { packageRoot, home, io },
          );
          assert.equal(result.exitCode, 2, entry.name);
          const err = stderr.join("");
          assert.match(err, /^ak-role: /, entry.name);
          assert.match(err, /sweep|field|contract|mode|mergedPullRequests/i, entry.name);

          const after = await snapshotTaishiDir(ledgerHome);
          assertSnapshotsEqual(before, after);
        }
      } finally {
        await rm(attachDir, { recursive: true, force: true });
      }
    });
  });
});

test("taishi public CLI sweep reject: --attach mixed with issue faces → typed + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);
      const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
      try {
        const path = await writeSweepAttachment(
          attachDir,
          "sweep-mix.json",
          `${JSON.stringify(VALID_SWEEP_INPUT)}\n`,
        );

        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["taishi", "--attach", path, "--project-root", ISSUE_ALPHA],
          { packageRoot, home, io },
        );

        assert.equal(result.exitCode, 2);
        const err = stderr.join("");
        assert.match(err, /^ak-role: /);
        assert.match(err, /attach/i);

        const after = await snapshotTaishiDir(ledgerHome);
        assertSnapshotsEqual(before, after);
      } finally {
        await rm(attachDir, { recursive: true, force: true });
      }
    });
  });
});
