/**
 * #336 taishi public CLI — separately callable role surface (ADR 0052 / ADR 0068).
 *
 * Sole external entry = ak-role taishi via PUBLIC_ROLE_ARGV single-table row.
 * Positive: ticket (index→projectRoot) and project-root (direct) match library
 * runTaishi same-input semantics (fixture hand oracle).
 * Negative: bare call / ticket with no index row+no fallback → typed error + zero writes.
 * Fixture issue numbers use 5xxx segment (avoid 1-4xxx family collisions).
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
import { PUBLIC_ROLE_ARGV, runAkRole } from "../../src/public-cli/cli.ts";
import {
  buildTaishiLibraryIndexPage,
  taishiLibraryIndexPath,
  writeTaishiLibraryIndexPage,
} from "../../src/taishi-index.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

/** Shared board root — hand-known legs live under this projectRoot. */
const ISSUE_DEMO = "/taishi-fixture/issue-demo";
/** C1 alpha root — independent project-root path oracle target. */
const ISSUE_ALPHA = "/taishi-fixture/c1-issue-alpha";

/** 5xxx segment — exclusive from C1-C4 (1-4xxx) issue/ticket numbers. */
const TICKET_HIT = 5501;
const TICKET_MISS = 5599;

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
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-336-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "taishi-336-home-"));
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

test("PUBLIC_ROLE_ARGV registers taishi parse in the single production table", () => {
  assert.equal(typeof PUBLIC_ROLE_ARGV.taishi.parse, "function");
  // #176 invariant: table remains the sole role→parse map (no parallel set).
  const keys = Object.keys(PUBLIC_ROLE_ARGV).sort();
  assert.equal(keys.includes("taishi"), true);
});

test("taishi public CLI ticket path: index hit resolves projectRoot; matches runTaishi oracle", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Seed unique issueNumber→projectRoot index row (ticket N = issueNumber).
      await writeTaishiLibraryIndexPage(
        ledgerHome,
        buildTaishiLibraryIndexPage([
          {
            projectRoot: physicalPathIdentity(ISSUE_DEMO),
            issueNumber: TICKET_HIT,
            totalElapsedMs: 0,
            changedLines: { status: "absent" },
            msPerKLines: { status: "absent" },
            lastActivityAt: { status: "absent" },
          },
        ]),
      );

      const oracle = await runTaishi({
        mode: "issue",
        projectRoot: physicalPathIdentity(ISSUE_DEMO),
        ticketNumber: TICKET_HIT,
        issueNumber: TICKET_HIT,
      });
      // Reset pages written by oracle so CLI path is the sole writer under test.
      await rm(join(ledgerHome, "taishi"), { recursive: true, force: true });
      await writeTaishiLibraryIndexPage(
        ledgerHome,
        buildTaishiLibraryIndexPage([
          {
            projectRoot: physicalPathIdentity(ISSUE_DEMO),
            issueNumber: TICKET_HIT,
            totalElapsedMs: 0,
            changedLines: { status: "absent" },
            msPerKLines: { status: "absent" },
            lastActivityAt: { status: "absent" },
          },
        ]),
      );

      const { io, stderr } = captureIo();
      const result = await runAkRole(["taishi", "--ticket", String(TICKET_HIT)], {
        packageRoot,
        home,
        io,
      });

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_DEMO);
      const page = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.equal(page.kind, "taishi-issue-metrics");
      assert.equal(page.projectRoot, oracle.page.projectRoot);
      assert.equal(page.issueNumber, TICKET_HIT);
      assert.deepEqual(page.legs, oracle.page.legs);
      assert.deepEqual(page.unreadable, oracle.page.unreadable);
      assert.equal(page.totalElapsedMs, oracle.page.totalElapsedMs);
      assert.deepEqual(page.scopeConflicts, oracle.page.scopeConflicts);

      // Index row retained / refreshed for the same issueNumber.
      const indexRaw = await readFile(taishiLibraryIndexPath(ledgerHome), "utf8");
      const index = JSON.parse(indexRaw) as {
        rows: readonly { issueNumber?: number; projectRoot: string }[];
      };
      const row = index.rows.find((r) => r.issueNumber === TICKET_HIT);
      assert.ok(row);
      assert.equal(row.projectRoot, physicalPathIdentity(ISSUE_DEMO));
    });
  });
});

test("taishi public CLI project-root path: direct supply matches runTaishi oracle", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");

      const oracle = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
      });
      await rm(join(ledgerHome, "taishi"), { recursive: true, force: true });

      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["taishi", "--project-root", ISSUE_ALPHA],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_ALPHA);
      const page = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.equal(page.kind, "taishi-issue-metrics");
      assert.equal(page.projectRoot, oracle.page.projectRoot);
      assert.deepEqual(page.legs, oracle.page.legs);
      assert.deepEqual(page.unreadable, oracle.page.unreadable);
      assert.equal(page.totalElapsedMs, oracle.page.totalElapsedMs);
      assert.deepEqual(page.scopeConflicts, oracle.page.scopeConflicts);
      // project-root-only path carries no issueNumber face.
      assert.equal(page.issueNumber, undefined);
    });
  });
});

test("taishi public CLI failure: bare call → typed usage + zero taishi writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Ensure taishi dir exists so snapshot has a stable before state.
      await mkdir(join(ledgerHome, "taishi"), { recursive: true });
      const before = await snapshotTaishiDir(ledgerHome);

      const { io, stderr } = captureIo();
      const result = await runAkRole(["taishi"], { packageRoot, home, io });

      assert.equal(result.exitCode, 2);
      const err = stderr.join("");
      assert.match(err, /^ak-role: /);
      assert.match(err, /usage:.*taishi/i);
      assert.match(err, /ticket|project-root/i);

      const after = await snapshotTaishiDir(ledgerHome);
      assertSnapshotsEqual(before, after);
    });
  });
});

test("taishi public CLI failure: ticket with no index row and no project-root → typed miss + zero writes", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      // Empty index (no row for TICKET_MISS).
      await writeTaishiLibraryIndexPage(ledgerHome, buildTaishiLibraryIndexPage([]));
      const before = await snapshotTaishiDir(ledgerHome);

      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["taishi", "--ticket", String(TICKET_MISS)],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 2);
      const err = stderr.join("");
      assert.match(err, /^ak-role: /);
      // Typed failure names the missing index row (issue/ticket number).
      assert.match(err, /library index/i);
      assert.match(err, new RegExp(String(TICKET_MISS)));
      assert.doesNotMatch(err, /usage:/i);

      const after = await snapshotTaishiDir(ledgerHome);
      assertSnapshotsEqual(before, after);

      // No issue page materialized for the miss.
      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_DEMO);
      await assert.rejects(() => stat(pagePath), (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOENT");
        return true;
      });
    });
  });
});
