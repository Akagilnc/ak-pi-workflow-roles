/**
 * #337 taishi public CLI sweep — caller-invoked attach path (ADR 0052 / ADR 0068).
 *
 * Positive: one typed JSON attach → pages+index match library runTaishi oracle.
 * Negative (3 classes, one zero-write fixture): cardinality / UTF-8|JSON / field contract.
 * Fixture identity: 7xxx segment reservation (reuse C1 boards; no new ledger runs).
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

import { runAkRole } from "../../src/public-cli/cli.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import {
  taishiLibraryIndexPath,
  type TaishiLibraryIndexPage,
} from "../../src/taishi-index.ts";
import type { TaishiIssueMetricsPage } from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

const ISSUE_DEMO = "/taishi-fixture/issue-demo";
const ISSUE_ALPHA = "/taishi-fixture/c1-issue-alpha";
const ISSUE_BETA = "/taishi-fixture/c1-issue-beta";

const VALID_SWEEP_INPUT = {
  mode: "sweep" as const,
  mergedPullRequests: [
    { projectRoot: ISSUE_DEMO, changedLines: 0 },
    { projectRoot: ISSUE_ALPHA, changedLines: 500 },
    { projectRoot: ISSUE_BETA },
  ],
};

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

/** Business-repo + fixture home + attach dir; asserts business tree stays clean. */
async function withSweepFixture<T>(
  fn: (ctx: {
    home: string;
    ledgerHome: string;
    attachDir: string;
  }) => Promise<T>,
): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-337-business-"));
  const home = await mkdtemp(join(tmpdir(), "taishi-337-home-"));
  const attachDir = await mkdtemp(join(tmpdir(), "taishi-337-attach-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
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
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    const result = await fn({
      home,
      ledgerHome: join(home, ".ak-roles"),
      attachDir,
    });
    assert.equal(gitPorcelain(businessRepo), "", "business repo zero write");
    return result;
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(attachDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(businessRepo, { recursive: true, force: true });
  }
}

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

test("taishi public CLI sweep: one typed attach → pages+index match runTaishi oracle", async () => {
  await withSweepFixture(async ({ home, ledgerHome, attachDir }) => {
    const attachPath = join(attachDir, "sweep-input.json");
    await writeFile(attachPath, `${JSON.stringify(VALID_SWEEP_INPUT)}\n`);

    const oracle = await runTaishi(VALID_SWEEP_INPUT);
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
    assert.deepEqual(
      receipt.issuePages.map((p) => p.page),
      oracle.issuePages.map((p) => p.page),
    );
    assert.deepEqual(receipt.index, oracle.index);
    assert.equal(receipt.indexPath, taishiLibraryIndexPath(ledgerHome));
    assert.deepEqual(
      JSON.parse(await readFile(taishiLibraryIndexPath(ledgerHome), "utf8")),
      oracle.index,
    );
  });
});

test("taishi public CLI sweep reject classes: typed envelope + zero writes", async () => {
  await withSweepFixture(async ({ home, ledgerHome, attachDir }) => {
    await mkdir(join(ledgerHome, "taishi"), { recursive: true });
    const before = await snapshotTaishiDir(ledgerHome);

    const validPath = join(attachDir, "valid.json");
    await writeFile(validPath, `${JSON.stringify(VALID_SWEEP_INPUT)}\n`);
    const validPathB = join(attachDir, "valid-b.json");
    await writeFile(validPathB, `${JSON.stringify(VALID_SWEEP_INPUT)}\n`);
    const badUtf8Path = join(attachDir, "bad-utf8.json");
    await writeFile(badUtf8Path, Buffer.from([0x7b, 0x80, 0x7d]));
    const badJsonPath = join(attachDir, "bad-json.json");
    await writeFile(badJsonPath, "{ not json\n");

    const fieldBodies: readonly { name: string; body: unknown }[] = [
      { name: "missing-mode.json", body: { mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }] } },
      {
        name: "extra-top.json",
        body: { mode: "sweep", mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }], extra: true },
      },
      {
        name: "wrong-mode.json",
        body: { mode: "issue", mergedPullRequests: [{ projectRoot: ISSUE_ALPHA }] },
      },
      {
        name: "entry-extra.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, issueNumber: 7 }],
        },
      },
      {
        name: "changedLines-type.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: "500" }],
        },
      },
      {
        name: "changedLines-negative.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: -1 }],
        },
      },
      {
        name: "changedLines-infinity.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: null }],
        },
      },
      // Type mismatch (not unauthorized nonempty): projectRoot must be string.
      {
        name: "projectRoot-type.json",
        body: {
          mode: "sweep",
          mergedPullRequests: [{ projectRoot: 1 }],
        },
      },
    ];
    const fieldPaths: { path: string; name: string }[] = [];
    for (const entry of fieldBodies) {
      const path = join(attachDir, entry.name);
      await writeFile(path, `${JSON.stringify(entry.body)}\n`);
      fieldPaths.push({ path, name: entry.name });
    }

    const cases: readonly {
      name: string;
      argv: readonly string[];
      err: RegExp;
    }[] = [
      // ① cardinality (0 / >1 / mixed with issue faces)
      { name: "no-attach", argv: ["taishi", "sweep"], err: /attach/i },
      {
        name: "multi-attach",
        argv: ["taishi", "--attach", validPath, "--attach", validPathB],
        err: /attach/i,
      },
      {
        // #399: --project-root deleted unconditionally (not a mix-face attach reject).
        name: "mix-deleted-project-root",
        argv: ["taishi", "--attach", validPath, "--project-root", ISSUE_ALPHA],
        err: /project-root/i,
      },
      // ② non-UTF-8 / JSON parse failure
      { name: "bad-utf8", argv: ["taishi", "--attach", badUtf8Path], err: /utf-8/i },
      { name: "bad-json", argv: ["taishi", "--attach", badJsonPath], err: /json/i },
      // ③ field missing / extra / wrong type
      ...fieldPaths.map((f) => ({
        name: f.name,
        argv: ["taishi", "--attach", f.path] as const,
        err: /sweep|field|contract|mode|mergedPullRequests|TaishiSweepModeInput/i,
      })),
    ];

    for (const entry of cases) {
      const { io, stderr } = captureIo();
      const result = await runAkRole([...entry.argv], { packageRoot, home, io });
      assert.equal(result.exitCode, 2, entry.name);
      const err = stderr.join("");
      assert.match(err, /^ak-role: /, entry.name);
      assert.match(err, entry.err, entry.name);
      assert.deepEqual(
        [...(await snapshotTaishiDir(ledgerHome)).entries()].sort(),
        [...before.entries()].sort(),
        entry.name,
      );
    }
  });
});
