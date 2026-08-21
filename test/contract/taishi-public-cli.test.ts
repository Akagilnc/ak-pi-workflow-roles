/**
 * #336 taishi public CLI — separately callable role surface (ADR 0052 / ADR 0068).
 * #399: ticket path is live book compute (no library-index bootstrap).
 *
 * Sole external entry = ak-role taishi via PUBLIC_ROLE_ARGV single-table row.
 * Positive: ticket (+ optional project-root) and project-root-only match library
 * runTaishi same-input semantics (fixture hand oracle).
 * Negative: bare call → typed usage + zero writes.
 * Ticket fixtures reuse C4 4xxx ticket faces (strict ticketNumber on runs).
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
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { parseTaishiArgv } from "../../src/public-cli/invocation.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

/** C1 alpha root — independent project-root path oracle target. */
const ISSUE_ALPHA = "/taishi-fixture/c1-issue-alpha";
/** C4 primary root — ticket path oracle (runs carry ticketNumber 4401). */
const ISSUE_C4_PRIMARY = "/taishi-fixture/c4-issue-primary";
/** C4 typed ticket face present on fixture runs. */
const TICKET_C4 = 4401;
/** Ticket with zero fixture bindings — live compute yields empty legs, not index miss. */
const TICKET_EMPTY = 5599;

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

test("taishi public CLI ticket path: live book compute matches runTaishi oracle (no index bootstrap)", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");

      const oracle = await runTaishi({
        mode: "issue",
        projectRoot: physicalPathIdentity(ISSUE_C4_PRIMARY),
        ticketNumber: TICKET_C4,
        issueNumber: TICKET_C4,
      });
      // Reset pages written by oracle so CLI path is the sole writer under test.
      await rm(join(ledgerHome, "taishi"), { recursive: true, force: true });

      const { io, stderr } = captureIo();
      const result = await runAkRole(
        [
          "taishi",
          "--ticket",
          String(TICKET_C4),
          "--project-root",
          ISSUE_C4_PRIMARY,
        ],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_C4_PRIMARY);
      const page = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.equal(page.kind, "taishi-issue-metrics");
      assert.equal(page.projectRoot, oracle.page.projectRoot);
      assert.equal(page.issueNumber, TICKET_C4);
      assert.deepEqual(page.legs, oracle.page.legs);
      assert.deepEqual(page.unreadable, oracle.page.unreadable);
      assert.equal(page.totalElapsedMs, oracle.page.totalElapsedMs);
      assert.deepEqual(page.scopeConflicts, oracle.page.scopeConflicts);
      // Strict ticket face: at least the C4 typed-match legs, never an empty miss-by-index.
      assert.ok(page.legs.length >= 1);
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

test("taishi public CLI ticket + project-root: project-root is book pointer; ticket filters (no index)", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");

      const oracle = await runTaishi({
        mode: "issue",
        projectRoot: physicalPathIdentity(ISSUE_C4_PRIMARY),
        ticketNumber: TICKET_C4,
        issueNumber: TICKET_C4,
      });
      await rm(join(ledgerHome, "taishi"), { recursive: true, force: true });

      const { io, stderr } = captureIo();
      const result = await runAkRole(
        [
          "taishi",
          "--ticket",
          String(TICKET_C4),
          "--project-root",
          ISSUE_C4_PRIMARY,
        ],
        { packageRoot, home, io },
      );

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_C4_PRIMARY);
      const page = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.equal(page.projectRoot, physicalPathIdentity(ISSUE_C4_PRIMARY));
      assert.equal(page.issueNumber, TICKET_C4);
      assert.deepEqual(page.legs, oracle.page.legs);
      // Alien-root ticket match still surfaces as scope conflict (C4 fact).
      assert.ok(
        page.scopeConflicts.some((c) => c.fact === "typed-ticketNumber-over-projectRoot"),
      );
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
      // Issue faces and/or sweep attach carrier (usage names both modes).
      assert.match(err, /ticket|project-root/i);
      assert.match(err, /attach/i);

      const after = await snapshotTaishiDir(ledgerHome);
      assertSnapshotsEqual(before, after);
    });
  });
});

test("taishi public CLI bare --ticket with no bindings: live empty page, not library-index miss", async () => {
  await withBusinessRepo(async (businessRepo) => {
    await withTempHome(async (home) => {
      const previousCwd = process.cwd();
      process.chdir(businessRepo);
      try {
        const { io, stdout, stderr } = captureIo();
        const result = await runAkRole(
          ["taishi", "--ticket", String(TICKET_EMPTY)],
          { packageRoot, home, io },
        );

        // #399: no index bootstrap — unbound ticket computes an empty honest page.
        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(stderr.join(""), "");
        const body = JSON.parse(stdout.join("")) as {
          mode: string;
          page: { issueNumber?: number; legs: readonly unknown[] };
        };
        assert.equal(body.mode, "issue");
        assert.equal(body.page.issueNumber, TICKET_EMPTY);
        assert.deepEqual(body.page.legs, []);
        assert.doesNotMatch(stdout.join(""), /library index/i);
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});

test("taishi ticket parse rejects unsafe integers and infinity-length digit strings", () => {
  assert.throws(
    () => parseTaishiArgv(["--ticket", "9007199254740992"]), // MAX_SAFE_INTEGER + 1
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--ticket/);
      assert.match(error.message, /positive integer/);
      return true;
    },
  );
  assert.throws(
    () => parseTaishiArgv(["--ticket", "9".repeat(400)]),
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--ticket/);
      return true;
    },
  );
  assert.throws(
    () =>
      parseTaishiArgv([
        "--cohort",
        "--group-a-label",
        "a",
        "--group-a-issues",
        "9007199254740993",
        "--group-b-label",
        "b",
        "--group-b-issues",
        "1",
      ]),
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--group-a-issues/);
      assert.doesNotMatch(error.message, /--ticket/);
      return true;
    },
  );
  // Boundary safe integer remains admitted.
  const ok = parseTaishiArgv(["--ticket", String(Number.MAX_SAFE_INTEGER)]);
  assert.equal(ok.query, "issue");
  if (ok.query === "issue") {
    assert.equal(ok.ticket, Number.MAX_SAFE_INTEGER);
  }
});

test("taishi cohort list parse names the actual group flag, not --ticket", () => {
  assert.throws(
    () =>
      parseTaishiArgv([
        "--cohort",
        "--group-a-label",
        "before",
        "--group-a-issues",
        "12,not-a-number",
        "--group-b-label",
        "after",
        "--group-b-issues",
        "34",
      ]),
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--group-a-issues/);
      assert.doesNotMatch(error.message, /--ticket/);
      return true;
    },
  );
  assert.throws(
    () =>
      parseTaishiArgv([
        "--cohort",
        "--group-a-label",
        "before",
        "--group-a-issues",
        "12",
        "--group-b-label",
        "after",
        "--group-b-issues",
        "0",
      ]),
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--group-b-issues/);
      assert.doesNotMatch(error.message, /--ticket/);
      return true;
    },
  );
});
