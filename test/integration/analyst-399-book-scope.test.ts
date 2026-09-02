/**
 * #399 analyst book-scope — three defects on the analysis seat (owner-ratified).
 *
 * 1) Ticket face must actually filter — never return a full-book page labeled
 *    issueNumber=N; no silent projectRoot fallback for unbound runs.
 * 2) Scope unit is the ledger book (cwd git common-dir); bare call = whole book
 *    across worktrees; --project-root deleted unconditionally (loud reject).
 * 3) --ticket N computes live from the book; library-index is not a bootstrap
 *    prerequisite (no "run once before you can query" dead loop).
 *
 * Fixture runId segment 019ff000-9xxx is exclusive to this file.
 * DoD D1–D7 mechanical checks use temp HOME only (real HOME zero write).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import { analystLibraryIndexPath } from "../../src/analyst-index.ts";
import {
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
} from "../../src/analyst-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Exclusive #399 ticket faces — outside C1–C4 / public-cli 5xxx ranges. */
const TICKET_A = 3991;
const TICKET_B = 3992;
const TICKET_EMPTY = 3999;
const TICKET_CROSS = 181;

const RUN_MAIN_NO_TICKET = "019ff000-9001-7000-8000-0000000009a1";
const RUN_WORKTREE_TICKET_A = "019ff000-9002-7000-8000-0000000009a2";
const RUN_MAIN_TICKET_A = "019ff000-9003-7000-8000-0000000009a3";
const RUN_MAIN_TICKET_B = "019ff000-9004-7000-8000-0000000009a4";
const RUN_WT2_NO_TICKET = "019ff000-9005-7000-8000-0000000009a5";
const RUN_DAMAGED = "019ff000-9006-7000-8000-0000000009a6";

const SESSION_JSONL = [
  JSON.stringify({
    type: "session",
    version: 3,
    id: "s-399",
    timestamp: "2026-08-21T00:00:00.000Z",
    cwd: "/analyst-fixture/399",
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

async function countAnalystFiles(home: string): Promise<number> {
  const root = join(home, ".ak-roles", "analyst");
  let count = 0;
  async function walk(dir: string): Promise<void> {
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
      const p = join(dir, name);
      const info = await stat(p);
      if (info.isDirectory()) await walk(p);
      else count += 1;
    }
  }
  await walk(root);
  return count;
}

async function writeReadableRun(input: {
  readonly bookDir: string;
  readonly runId: string;
  readonly role: string;
  readonly projectRoot: string;
  readonly ticketNumber?: number;
}): Promise<void> {
  const runDir = join(input.bookDir, "runs", `${input.runId}@${input.role}`);
  await mkdir(join(runDir, "session"), { recursive: true });
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  const invocation: Record<string, unknown> = {
    role: input.role,
    runId: input.runId,
    bookKey: basename(input.bookDir),
    projectRoot: input.projectRoot,
  };
  if (input.ticketNumber !== undefined) {
    invocation.ticketNumber = input.ticketNumber;
  }
  await writeFile(join(runDir, "invocation.json"), `${JSON.stringify(invocation, null, 2)}\n`);
  await writeFile(join(runDir, "session", "session.jsonl"), SESSION_JSONL);
  await writeFile(
    join(runDir, "artifacts", "report.json"),
    `${JSON.stringify({
      role: input.role,
      runId: input.runId,
      phase: "apply",
      outcome: {
        kind: "accepted",
        role: input.role,
        status: "completed",
        decisiveFacts: {},
      },
    }, null, 2)}\n`,
  );
}

async function writeDamagedRun(input: {
  readonly bookDir: string;
  readonly runId: string;
  readonly role: string;
  readonly projectRoot: string;
  readonly ticketNumber?: number;
}): Promise<void> {
  const runDir = join(input.bookDir, "runs", `${input.runId}@${input.role}`);
  await mkdir(join(runDir, "session"), { recursive: true });
  const invocation: Record<string, unknown> = {
    role: input.role,
    runId: input.runId,
    bookKey: basename(input.bookDir),
    projectRoot: input.projectRoot,
  };
  if (input.ticketNumber !== undefined) {
    invocation.ticketNumber = input.ticketNumber;
  }
  await writeFile(join(runDir, "invocation.json"), `${JSON.stringify(invocation, null, 2)}\n`);
  // Broken session JSONL — unreadable exclusion, not silent drop.
  await writeFile(join(runDir, "session", "session.jsonl"), "{not-json\n");
}

/**
 * Real git repo (book key = basename) + main + 2 worktrees + ledger runs.
 */
async function withBookScopeWorld<T>(
  fn: (ctx: {
    readonly home: string;
    readonly mainRoot: string;
    readonly worktreeRoot: string;
    readonly worktree2Root: string;
    readonly bookKey: string;
  }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "analyst-399-home-"));
  const mainRoot = await mkdtemp(join(tmpdir(), "analyst-399-main-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let worktreeRoot = "";
  let worktree2Root = "";
  try {
    execFileSync("git", ["init"], { cwd: mainRoot });
    execFileSync("git", ["branch", "-M", "main"], { cwd: mainRoot });
    await writeFile(join(mainRoot, "README.md"), "399\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: mainRoot });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: mainRoot },
    );

    worktreeRoot = join(await mkdtemp(join(tmpdir(), "analyst-399-wt1-")), "wt");
    worktree2Root = join(await mkdtemp(join(tmpdir(), "analyst-399-wt2-")), "wt");
    execFileSync("git", ["worktree", "add", worktreeRoot, "-b", "wt1"], { cwd: mainRoot });
    execFileSync("git", ["worktree", "add", worktree2Root, "-b", "wt2"], { cwd: mainRoot });

    const bookKey = basename(mainRoot);
    const bookDir = join(home, ".ak-roles", "books", bookKey);
    await mkdir(join(bookDir, "runs"), { recursive: true });

    await writeReadableRun({
      bookDir,
      runId: RUN_MAIN_NO_TICKET,
      role: "coder",
      projectRoot: mainRoot,
    });
    await writeReadableRun({
      bookDir,
      runId: RUN_WORKTREE_TICKET_A,
      role: "judge",
      projectRoot: worktreeRoot,
      ticketNumber: TICKET_A,
    });
    await writeReadableRun({
      bookDir,
      runId: RUN_MAIN_TICKET_A,
      role: "fixer",
      projectRoot: mainRoot,
      ticketNumber: TICKET_A,
    });
    await writeReadableRun({
      bookDir,
      runId: RUN_MAIN_TICKET_B,
      role: "reviewer",
      projectRoot: mainRoot,
      ticketNumber: TICKET_B,
    });
    await writeReadableRun({
      bookDir,
      runId: RUN_WT2_NO_TICKET,
      role: "coder",
      projectRoot: worktree2Root,
    });
    await writeDamagedRun({
      bookDir,
      runId: RUN_DAMAGED,
      role: "doctor",
      projectRoot: mainRoot,
      ticketNumber: TICKET_A,
    });

    return await fn({ home, mainRoot, worktreeRoot, worktree2Root, bookKey });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(mainRoot, { recursive: true, force: true });
    if (worktreeRoot) await rm(worktreeRoot, { recursive: true, force: true }).catch(() => undefined);
    if (worktree2Root) await rm(worktree2Root, { recursive: true, force: true }).catch(() => undefined);
  }
}

// D1
test("D1 analyst #399 --ticket filters strictly; empty of unbound; != bare set", async () => {
  await withBookScopeWorld(async ({ home, mainRoot }) => {
    const previousCwd = process.cwd();
    process.chdir(mainRoot);
    try {
      const bare = captureIo();
      const bareResult = await runAkRole(["analyst"], { packageRoot, home, io: bare.io });
      assert.equal(bareResult.exitCode, 0, bare.stderr.join(""));
      const bareBody = JSON.parse(bare.stdout.join("")) as {
        page: { legs: readonly { runId: string }[]; issueNumber?: number };
      };
      const bareIds = bareBody.page.legs.map((l) => l.runId).sort();

      const ticketed = captureIo();
      const ticketResult = await runAkRole(
        ["analyst", "--ticket", String(TICKET_A)],
        { packageRoot, home, io: ticketed.io },
      );
      assert.equal(ticketResult.exitCode, 0, ticketed.stderr.join(""));
      const body = JSON.parse(ticketed.stdout.join("")) as {
        page: {
          issueNumber?: number;
          legs: readonly { runId: string }[];
          unreadable: readonly { runId: string }[];
        };
      };
      assert.equal(body.page.issueNumber, TICKET_A);
      const ticketIds = body.page.legs.map((l) => l.runId).sort();
      assert.notDeepEqual(ticketIds, bareIds);
      // Strict typed ticket — only TICKET_A readable legs; unbound main/wt2 out.
      assert.deepEqual(ticketIds, [RUN_WORKTREE_TICKET_A, RUN_MAIN_TICKET_A].sort());
      assert.equal(ticketIds.includes(RUN_MAIN_NO_TICKET), false);
      assert.equal(ticketIds.includes(RUN_MAIN_TICKET_B), false);
      // Damaged ticket-A run is unreadable exclusion, not silent drop (D7 sample).
      assert.ok(body.page.unreadable.some((u) => u.runId === RUN_DAMAGED));
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// D2
test("D2 analyst #399 bare sees main+2 worktree runs; --project-root rejected", async () => {
  await withBookScopeWorld(async ({ home, mainRoot, worktreeRoot }) => {
    const previousCwd = process.cwd();
    process.chdir(worktreeRoot);
    try {
      const bare = captureIo();
      const bareResult = await runAkRole(["analyst"], { packageRoot, home, io: bare.io });
      assert.equal(bareResult.exitCode, 0, bare.stderr.join(""));
      const body = JSON.parse(bare.stdout.join("")) as {
        page: { legs: readonly { runId: string }[]; bookKey: string };
      };
      const ids = new Set(body.page.legs.map((l) => l.runId));
      assert.equal(ids.has(RUN_MAIN_NO_TICKET), true);
      assert.equal(ids.has(RUN_WORKTREE_TICKET_A), true);
      assert.equal(ids.has(RUN_WT2_NO_TICKET), true);

      const rejected = captureIo();
      const rejectResult = await runAkRole(
        ["analyst", "--project-root", mainRoot],
        { packageRoot, home, io: rejected.io },
      );
      assert.equal(rejectResult.exitCode, 2);
      assert.match(rejected.stderr.join(""), /project-root/i);
      assert.match(rejected.stderr.join(""), /deleted|bare|--ticket/i);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// D3
test("D3 analyst #399 --ticket without library-index: live book compute", async () => {
  await withBookScopeWorld(async ({ home, mainRoot }) => {
    await assert.rejects(
      () =>
        import("node:fs/promises").then((fs) =>
          fs.stat(analystLibraryIndexPath(join(home, ".ak-roles"))),
        ),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOENT");
        return true;
      },
    );

    const previousCwd = process.cwd();
    process.chdir(mainRoot);
    try {
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(["analyst", "--ticket", String(TICKET_A)], {
        packageRoot,
        home,
        io,
      });
      assert.equal(result.exitCode, 0, stderr.join(""));
      const body = JSON.parse(stdout.join("")) as {
        page: { issueNumber?: number; legs: readonly { runId: string }[] };
      };
      assert.equal(body.page.issueNumber, TICKET_A);
      assert.deepEqual(
        body.page.legs.map((l) => l.runId).sort(),
        [RUN_WORKTREE_TICKET_A, RUN_MAIN_TICKET_A].sort(),
      );
      assert.doesNotMatch(stdout.join("") + stderr.join(""), /library index|index miss/i);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// D4
test("D4 analyst #399 non-git cwd bare: nonzero + must-enter-repo; analyst file count stable", async () => {
  const home = await mkdtemp(join(tmpdir(), "analyst-399-nongit-home-"));
  const nonGit = await mkdtemp(join(tmpdir(), "analyst-399-nongit-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const previousCwd = process.cwd();
  try {
    await mkdir(join(home, ".ak-roles", "analyst"), { recursive: true });
    const before = await countAnalystFiles(home);
    process.chdir(nonGit);
    const { io, stderr } = captureIo();
    const result = await runAkRole(["analyst"], { packageRoot, home, io });
    assert.notEqual(result.exitCode, 0);
    assert.match(stderr.join(""), /git repository|common-dir|inside a repository/i);
    const after = await countAnalystFiles(home);
    assert.equal(after, before);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(nonGit, { recursive: true, force: true });
  }
});

// D5
test("D5 analyst #399 two books ticket 181: pages distinct by book identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "analyst-399-d5-home-"));
  const repoA = await mkdtemp(join(tmpdir(), "analyst-399-d5-a-"));
  const repoB = await mkdtemp(join(tmpdir(), "analyst-399-d5-b-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const previousCwd = process.cwd();
  try {
    for (const repo of [repoA, repoB]) {
      execFileSync("git", ["init"], { cwd: repo });
      await writeFile(join(repo, "README.md"), "x\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
        { cwd: repo },
      );
      const bookKey = basename(repo);
      const bookDir = join(home, ".ak-roles", "books", bookKey);
      await mkdir(join(bookDir, "runs"), { recursive: true });
      await writeReadableRun({
        bookDir,
        runId: `019ff000-91${bookKey.slice(-2)}-7000-8000-0000000009c1`.slice(0, 36).padEnd(36, "0"),
        role: "coder",
        projectRoot: repo,
        ticketNumber: TICKET_CROSS,
      });
    }

    process.chdir(repoA);
    const a = captureIo();
    assert.equal(
      (await runAkRole(["analyst", "--ticket", String(TICKET_CROSS)], { packageRoot, home, io: a.io }))
        .exitCode,
      0,
      a.stderr.join(""),
    );
    const pageA = (JSON.parse(a.stdout.join("")) as { page: AnalystIssueMetricsPage; pagePath: string });

    process.chdir(repoB);
    const b = captureIo();
    assert.equal(
      (await runAkRole(["analyst", "--ticket", String(TICKET_CROSS)], { packageRoot, home, io: b.io }))
        .exitCode,
      0,
      b.stderr.join(""),
    );
    const pageB = (JSON.parse(b.stdout.join("")) as { page: AnalystIssueMetricsPage; pagePath: string });

    assert.equal(pageA.page.issueNumber, TICKET_CROSS);
    assert.equal(pageB.page.issueNumber, TICKET_CROSS);
    assert.notEqual(pageA.page.bookKey, pageB.page.bookKey);
    assert.notEqual(pageA.pagePath, pageB.pagePath);
    assert.equal(
      pageA.pagePath,
      analystIssuePagePath(join(home, ".ak-roles"), {
        bookKey: pageA.page.bookKey,
        issueNumber: TICKET_CROSS,
      }),
    );
    assert.equal(
      pageB.pagePath,
      analystIssuePagePath(join(home, ".ak-roles"), {
        bookKey: pageB.page.bookKey,
        issueNumber: TICKET_CROSS,
      }),
    );
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

// D6
test("D6 analyst #399 unmatched ticket: honest empty page, no full-book fallback", async () => {
  await withBookScopeWorld(async ({ home, mainRoot }) => {
    const previousCwd = process.cwd();
    process.chdir(mainRoot);
    try {
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["analyst", "--ticket", String(TICKET_EMPTY)],
        { packageRoot, home, io },
      );
      assert.equal(result.exitCode, 0, stderr.join(""));
      const body = JSON.parse(stdout.join("")) as {
        page: {
          issueNumber?: number;
          legs: readonly unknown[];
          unreadableCount: number;
        };
      };
      assert.equal(body.page.issueNumber, TICKET_EMPTY);
      assert.deepEqual(body.page.legs, []);
      assert.equal(body.page.unreadableCount, 0);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// D7
test("D7 analyst #399 damaged invocation/session stays unreadable (loud exclusion)", async () => {
  await withBookScopeWorld(async ({ home, mainRoot, bookKey }) => {
    const result = await runAnalyst({
      mode: "issue",
      bookKey,
      projectRoot: mainRoot,
      ticketNumber: TICKET_A,
      issueNumber: TICKET_A,
    }, { home });
    assert.ok(result.page.unreadable.some((u) => u.runId === RUN_DAMAGED));
    assert.equal(result.page.legs.some((l) => l.runId === RUN_DAMAGED), false);
  });
});

// library API: book scope without path filter
test("analyst #399 library bookKey scope: whole book includes worktree runs", async () => {
  await withBookScopeWorld(async ({ home, mainRoot, bookKey }) => {
    const result = await runAnalyst({
      mode: "issue",
      bookKey,
      projectRoot: mainRoot,
    }, { home });
    const runIds = result.page.legs.map((leg) => leg.runId).sort();
    assert.deepEqual(
      runIds,
      [
        RUN_MAIN_NO_TICKET,
        RUN_WORKTREE_TICKET_A,
        RUN_MAIN_TICKET_A,
        RUN_MAIN_TICKET_B,
        RUN_WT2_NO_TICKET,
      ].sort(),
    );
    assert.equal(result.page.bookKey, bookKey);
    assert.equal(result.page.issueNumber, undefined);
  });
});
