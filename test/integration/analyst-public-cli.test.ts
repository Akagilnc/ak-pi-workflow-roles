/**
 * #336 analyst public CLI — separately callable role surface (ADR 0052 / ADR 0068).
 * #399: issue query = bare whole book / --ticket N from cwd git common-dir;
 *       --project-root deleted; --model-groups public face disabled; no library-index bootstrap.
 *
 * Sole external entry = ak-role analyst via PUBLIC_ROLE_ARGV single-table row.
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
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { PUBLIC_ROLE_ARGV, runAkRole } from "../../src/public-cli/cli.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { parseAnalystArgv, parseAnalystCohortIssueToken } from "../../src/public-cli/invocation.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import {
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
} from "../../src/analyst-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/analyst/home");

/** C4 typed ticket face present on fixture runs. */
const TICKET_C4 = 4401;
/** Ticket with zero fixture bindings — live compute yields empty legs, not index miss. */
const TICKET_EMPTY = 5599;

const SESSION_JSONL = [
  JSON.stringify({
    type: "session",
    version: 3,
    id: "s-336",
    timestamp: "2026-08-21T00:00:00.000Z",
    cwd: "/analyst-fixture/336",
  }),
  JSON.stringify({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
    message: { role: "assistant", timestamp: "2026-08-21T00:00:00.000Z", content: [] },
  }),
  JSON.stringify({
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-08-21T00:00:10.000Z",
    message: { role: "assistant", timestamp: "2026-08-21T00:00:10.000Z", content: [] },
  }),
].join("\n") + "\n";

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
  const businessRepo = await mkdtemp(join(tmpdir(), "analyst-336-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "analyst-336-home-"));
  try {
    await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Recursive analyst-dir snapshot for zero-write oracle (path → file bytes). */
async function snapshotAnalystDir(ledgerHome: string): Promise<Map<string, string>> {
  const root = join(ledgerHome, "analyst");
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
    assert.equal(after.get(key), bytes, `analyst file changed: ${key}`);
  }
}

async function seedBookTicketRun(input: {
  readonly home: string;
  readonly repo: string;
  readonly ticketNumber: number;
  readonly runId: string;
}): Promise<string> {
  const bookKey = basename(input.repo);
  const runDir = join(
    input.home,
    ".ak-roles",
    "books",
    bookKey,
    "runs",
    `${input.runId}@coder`,
  );
  await mkdir(join(runDir, "session"), { recursive: true });
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  await writeFile(
    join(runDir, "invocation.json"),
    `${JSON.stringify({
      role: "coder",
      runId: input.runId,
      bookKey,
      projectRoot: input.repo,
      ticketNumber: input.ticketNumber,
    }, null, 2)}\n`,
  );
  await writeFile(join(runDir, "session", "session.jsonl"), SESSION_JSONL);
  await writeFile(
    join(runDir, "artifacts", "report.json"),
    `${JSON.stringify({
      role: "coder",
      runId: input.runId,
      phase: "apply",
      outcome: {
        kind: "accepted",
        role: "coder",
        status: "completed",
        decisiveFacts: {},
      },
    }, null, 2)}\n`,
  );
  return bookKey;
}

test("PUBLIC_ROLE_ARGV registers analyst parse in the single production table", () => {
  assert.equal(typeof PUBLIC_ROLE_ARGV.analyst.parse, "function");
  // #176 invariant: table remains the sole role→parse map (no parallel set).
  const keys = Object.keys(PUBLIC_ROLE_ARGV).sort();
  assert.equal(keys.includes("analyst"), true);
});

test("analyst public CLI --ticket path: live book compute matches runAnalyst oracle", async () => {
  await withBusinessRepo(async (repo) => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      const runId = "019ff000-5501-7000-8000-0000000005a1";
      const bookKey = await seedBookTicketRun({
        home,
        repo,
        ticketNumber: TICKET_C4,
        runId,
      });

      const oracle = await runAnalyst({
        mode: "issue",
        bookKey,
        projectRoot: physicalPathIdentity(repo),
        ticketNumber: TICKET_C4,
        issueNumber: TICKET_C4,
      }, { home });
      await rm(join(ledgerHome, "analyst"), { recursive: true, force: true });

      const previousCwd = process.cwd();
      process.chdir(repo);
      try {
        const { io, stderr } = captureIo();
        const result = await runAkRole(
          ["analyst", "--ticket", String(TICKET_C4)],
          { packageRoot, home, io },
        );
        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(stderr.join(""), "");

        const pagePath = analystIssuePagePath(ledgerHome, {
          bookKey,
          issueNumber: TICKET_C4,
        });
        const page = JSON.parse(await readFile(pagePath, "utf8")) as AnalystIssueMetricsPage;
        assert.equal(page.kind, "analyst-issue-metrics");
        assert.equal(page.bookKey, bookKey);
        assert.equal(page.issueNumber, TICKET_C4);
        assert.deepEqual(page.legs, oracle.page.legs);
        assert.ok(page.legs.some((leg) => leg.runId === runId));
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});

test("analyst public CLI bare call: whole book from cwd git common-dir", async () => {
  await withBusinessRepo(async (repo) => {
    await withTempHome(async (home) => {
      const runId = "019ff000-5502-7000-8000-0000000005a2";
      const bookKey = await seedBookTicketRun({
        home,
        repo,
        ticketNumber: 77,
        runId,
      });
      const previousCwd = process.cwd();
      process.chdir(repo);
      try {
        const { io, stdout, stderr } = captureIo();
        const result = await runAkRole(["analyst"], { packageRoot, home, io });
        assert.equal(result.exitCode, 0, stderr.join(""));
        const body = JSON.parse(stdout.join("")) as {
          page: { bookKey: string; issueNumber?: number; legs: readonly { runId: string }[] };
        };
        assert.equal(body.page.bookKey, bookKey);
        assert.equal(body.page.issueNumber, undefined);
        assert.ok(body.page.legs.some((leg) => leg.runId === runId));
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});

test("analyst public CLI --project-root: deleted, loud reject", async () => {
  await withBusinessRepo(async (repo) => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "analyst"), { recursive: true });
      const before = await snapshotAnalystDir(ledgerHome);
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["analyst", "--project-root", repo],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /project-root/i);
      assert.match(stderr.join(""), /deleted|bare|--ticket/i);
      const after = await snapshotAnalystDir(ledgerHome);
      assertSnapshotsEqual(before, after);
    });
  });
});

test("analyst public CLI --model-groups: disabled, redesign message", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await mkdir(join(ledgerHome, "analyst"), { recursive: true });
      const before = await snapshotAnalystDir(ledgerHome);
      const { io, stderr } = captureIo();
      const result = await runAkRole(
        ["analyst", "--model-groups"],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 2);
      assert.match(stderr.join(""), /model-groups/i);
      assert.match(stderr.join(""), /disabled|redesign|multi-issue|follow-up/i);
      const after = await snapshotAnalystDir(ledgerHome);
      assertSnapshotsEqual(before, after);
    });
  });
});

test("analyst public CLI non-git cwd bare: usage-class failure + zero analyst writes", async () => {
  await withTempHome(async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    await mkdir(join(ledgerHome, "analyst"), { recursive: true });
    const before = await snapshotAnalystDir(ledgerHome);
    const nonGit = await mkdtemp(join(tmpdir(), "analyst-336-nongit-"));
    const previousCwd = process.cwd();
    process.chdir(nonGit);
    try {
      const { io, stderr } = captureIo();
      const result = await runAkRole(["analyst"], { packageRoot, home, io });
      assert.notEqual(result.exitCode, 0);
      assert.match(stderr.join(""), /git repository|common-dir|inside a repository/i);
      const after = await snapshotAnalystDir(ledgerHome);
      assertSnapshotsEqual(before, after);
    } finally {
      process.chdir(previousCwd);
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});

test("analyst public CLI bare --ticket with no bindings: live empty page, not library-index miss", async () => {
  await withBusinessRepo(async (businessRepo) => {
    await withTempHome(async (home) => {
      const previousCwd = process.cwd();
      process.chdir(businessRepo);
      try {
        const { io, stdout, stderr } = captureIo();
        const result = await runAkRole(
          ["analyst", "--ticket", String(TICKET_EMPTY)],
          { packageRoot, home, io },
        );

        // #399: no index bootstrap — unbound ticket computes an empty honest page.
        assert.equal(result.exitCode, 0, stderr.join(""));
        assert.equal(stderr.join(""), "");
        const body = JSON.parse(stdout.join("")) as {
          mode: string;
          page: { issueNumber?: number; legs: readonly unknown[]; unreadableCount: number };
        };
        assert.equal(body.mode, "issue");
        assert.equal(body.page.issueNumber, TICKET_EMPTY);
        assert.deepEqual(body.page.legs, []);
        assert.equal(body.page.unreadableCount, 0);
        assert.doesNotMatch(stdout.join(""), /library index/i);
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});

test("analyst ticket parse rejects unsafe integers and infinity-length digit strings", () => {
  assert.throws(
    () => parseAnalystArgv(["--ticket", "9007199254740992"]), // MAX_SAFE_INTEGER + 1
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--ticket/);
      assert.match(error.message, /positive integer/);
      return true;
    },
  );
  assert.throws(
    () => parseAnalystArgv(["--ticket", "9".repeat(400)]),
    (error: unknown) => {
      assert.ok(error instanceof CliUsageError);
      assert.match(error.message, /--ticket/);
      return true;
    },
  );
  assert.throws(
    () =>
      parseAnalystArgv([
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
  const ok = parseAnalystArgv(["--ticket", String(Number.MAX_SAFE_INTEGER)]);
  assert.equal(ok.query, "issue");
  if (ok.query === "issue") {
    assert.equal(ok.ticket, Number.MAX_SAFE_INTEGER);
  }
  // Bare issue argv is lawful (#399).
  assert.equal(parseAnalystArgv([]).query, "issue");
});

test("analyst cohort list parse names the actual group flag, not --ticket", () => {
  assert.throws(
    () =>
      parseAnalystArgv([
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
      parseAnalystArgv([
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

// #412: synthetic root:<path> book keys contain colons — book:N splits on the
// last colon only. Not covered by the public tracer (its books have no ":").
test("analyst cohort book:N splits on the last colon so root:<path>:N parses", () => {
  assert.deepEqual(parseAnalystCohortIssueToken("root:/tmp/a:b:181", "--group-a-issues"), {
    kind: "book-qualified",
    bookKey: "root:/tmp/a:b",
    issueNumber: 181,
  });
});
