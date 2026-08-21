/**
 * #399 taishi book-scope — three defects on the analysis seat.
 *
 * 1) Ticket face must actually filter (or fail loud) — never return a
 *    full-project page labeled issueNumber=N.
 * 2) Scope unit is the ledger book (git common-dir key); --project-root is
 *    only the book pointer / optional workspace narrow — worktree runs in the
 *    same book must remain visible.
 * 3) --ticket N computes live from the book; library-index is not a bootstrap
 *    prerequisite (no "run once before you can query" dead loop).
 *
 * Fixture runId segment 019ff000-9xxx is exclusive to this file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import { taishiLibraryIndexPath } from "../../src/taishi-index.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Exclusive #399 ticket faces — outside C1–C4 / public-cli 5xxx ranges. */
const TICKET_A = 3991;
const TICKET_B = 3992;

const RUN_MAIN_NO_TICKET = "019ff000-9001-7000-8000-0000000009a1";
const RUN_WORKTREE_TICKET_A = "019ff000-9002-7000-8000-0000000009a2";
const RUN_MAIN_TICKET_A = "019ff000-9003-7000-8000-0000000009a3";
const RUN_MAIN_TICKET_B = "019ff000-9004-7000-8000-0000000009a4";

const SESSION_JSONL = [
  JSON.stringify({
    type: "session",
    version: 3,
    id: "s-399",
    timestamp: "2026-08-21T00:00:00.000Z",
    cwd: "/taishi-fixture/399",
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

/**
 * Real git repo (book key = basename) + ledger book with four legs:
 *   main/no-ticket, worktree/ticket-A, main/ticket-A, main/ticket-B.
 * Mirrors production: one book, many worktree projectRoots, typed tickets.
 */
async function withBookScopeWorld<T>(
  fn: (ctx: {
    readonly home: string;
    readonly mainRoot: string;
    readonly worktreeRoot: string;
    readonly bookKey: string;
  }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "taishi-399-home-"));
  const mainRoot = await mkdtemp(join(tmpdir(), "taishi-399-main-"));
  const worktreeRoot = await mkdtemp(join(tmpdir(), "taishi-399-wt-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    execFileSync("git", ["init"], { cwd: mainRoot });
    await writeFile(join(mainRoot, "README.md"), "399\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: mainRoot });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: mainRoot },
    );

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

    return await fn({ home, mainRoot, worktreeRoot, bookKey });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(mainRoot, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

test("taishi #399 book scope: projectRoot resolves book; worktree runs stay visible", async () => {
  await withBookScopeWorld(async ({ mainRoot }) => {
    const result = await runTaishi({
      mode: "issue",
      projectRoot: mainRoot,
    });

    assert.equal(result.mode, "issue");
    const runIds = result.page.legs.map((leg) => leg.runId).sort();
    // Whole book — not the main-root path slice (which would drop the worktree leg).
    assert.deepEqual(runIds, [
      RUN_MAIN_NO_TICKET,
      RUN_WORKTREE_TICKET_A,
      RUN_MAIN_TICKET_A,
      RUN_MAIN_TICKET_B,
    ].sort());
  });
});

test("taishi #399 ticket face: filters by ticketNumber; never equals full book/project page", async () => {
  await withBookScopeWorld(async ({ mainRoot }) => {
    const full = await runTaishi({
      mode: "issue",
      projectRoot: mainRoot,
    });
    const ticketed = await runTaishi({
      mode: "issue",
      projectRoot: mainRoot,
      ticketNumber: TICKET_A,
      issueNumber: TICKET_A,
    });

    assert.equal(ticketed.page.issueNumber, TICKET_A);
    const fullIds = full.page.legs.map((leg) => leg.runId).sort();
    const ticketIds = ticketed.page.legs.map((leg) => leg.runId).sort();

    // Defect 1 red shape: labeled ticket page must not be the full-project set.
    assert.notDeepEqual(ticketIds, fullIds);

    // Strict typed ticket — no-ticket main-root leg and other ticket stay out.
    assert.deepEqual(ticketIds, [RUN_WORKTREE_TICKET_A, RUN_MAIN_TICKET_A].sort());
    assert.equal(ticketIds.includes(RUN_MAIN_NO_TICKET), false);
    assert.equal(ticketIds.includes(RUN_MAIN_TICKET_B), false);
  });
});

test("taishi #399 bare --ticket computes from book without library-index bootstrap", async () => {
  await withBookScopeWorld(async ({ home, mainRoot }) => {
    // No library-index file at all — ticket path must not require a prior row.
    await assert.rejects(
      () => import("node:fs/promises").then((fs) => fs.stat(taishiLibraryIndexPath(join(home, ".ak-roles")))),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOENT");
        return true;
      },
    );

    const previousCwd = process.cwd();
    process.chdir(mainRoot);
    try {
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(["taishi", "--ticket", String(TICKET_A)], {
        packageRoot,
        home,
        io,
      });

      assert.equal(result.exitCode, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");

      const body = JSON.parse(stdout.join("")) as {
        mode: string;
        page: {
          issueNumber?: number;
          legs: readonly { runId: string }[];
        };
      };
      assert.equal(body.mode, "issue");
      assert.equal(body.page.issueNumber, TICKET_A);
      assert.deepEqual(
        body.page.legs.map((leg) => leg.runId).sort(),
        [RUN_WORKTREE_TICKET_A, RUN_MAIN_TICKET_A].sort(),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("taishi #399 CLI --ticket + --project-root: ticket filters inside git-resolved book", async () => {
  await withBookScopeWorld(async ({ home, mainRoot }) => {
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "taishi",
        "--ticket",
        String(TICKET_A),
        "--project-root",
        mainRoot,
      ],
      { packageRoot, home, io },
    );

    assert.equal(result.exitCode, 0, stderr.join(""));
    const body = JSON.parse(stdout.join("")) as {
      page: {
        issueNumber?: number;
        projectRoot: string;
        legs: readonly { runId: string }[];
      };
    };
    assert.equal(body.page.issueNumber, TICKET_A);
    assert.equal(body.page.projectRoot, physicalPathIdentity(mainRoot));
    assert.deepEqual(
      body.page.legs.map((leg) => leg.runId).sort(),
      [RUN_WORKTREE_TICKET_A, RUN_MAIN_TICKET_A].sort(),
    );
  });
});
