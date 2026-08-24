/**
 * #329 analyst-C1 — sweep mode + library index page tracer.
 *
 * Typed input = merged PR list + LOC → backfill issue pages (idempotent overwrite)
 * and maintain the library index (one self-sufficient row per issue).
 * LOC absent/0 → typed 空缺 for 耗时/千行 (never 0 or Infinity).
 * C1 fixture runs use exclusive runId segment 019ff000-1xxx.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import {
  buildAnalystLibraryIndexPage,
  mergeAnalystLibraryIndexRows,
  analystLibraryIndexPath,
  writeAnalystLibraryIndexPage,
  type AnalystLibraryIndexPage,
  type AnalystLibraryIndexRow,
} from "../../src/analyst-index.ts";
import {
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
  type AnalystOptionalMetricNumber,
  type AnalystOptionalTimestamp,
} from "../../src/analyst-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/analyst/home");

/** Shared board (B-wave) — totalElapsedMs/lastActivityAt hand-known. */
const ISSUE_DEMO = "/analyst-fixture/issue-demo";
/** C1-owned fixture — runId 019ff000-1001, wall 40_000. */
const ISSUE_ALPHA = "/analyst-fixture/c1-issue-alpha";
/** C1-owned fixture — runId 019ff000-1002, wall 10_000. */
const ISSUE_BETA = "/analyst-fixture/c1-issue-beta";
/**
 * C1-owned negative: readable earlier + newer terminal-unreadable with later end-frame.
 * runIds 019ff000-1003 / 019ff000-1004.
 */
const ISSUE_GAMMA = "/analyst-fixture/c1-issue-gamma";

const C1_ALPHA_RUN = "019ff000-1001-7000-8000-0000000001a1";
const C1_BETA_RUN = "019ff000-1002-7000-8000-0000000001b2";
const C1_GAMMA_READABLE_RUN = "019ff000-1003-7000-8000-0000000001c3";
const C1_GAMMA_UNREADABLE_RUN = "019ff000-1004-7000-8000-0000000001d4";

/**
 * Hand values from shared board (B1 total) + max available endedAt across ALL runs.
 * Σ wallMs = 302_000; latest endedAt = f1 @ 00:12:25.
 */
const DEMO_TOTAL_ELAPSED_MS = 302_000;
const DEMO_LAST_ACTIVITY_AT = "2026-08-01T00:12:25.000Z";

/** Alpha: single leg wall 40s @ 2026-08-02T00:00:00→00:00:40. */
const ALPHA_TOTAL_ELAPSED_MS = 40_000;
const ALPHA_LAST_ACTIVITY_AT = "2026-08-02T00:00:40.000Z";

/** Beta: single leg wall 10s @ 2026-08-02T01:00:00→01:00:10. */
const BETA_TOTAL_ELAPSED_MS = 10_000;
const BETA_LAST_ACTIVITY_AT = "2026-08-02T01:00:10.000Z";

/**
 * Gamma hand values:
 * - readable 1003 wall 20s ends 02:00:20 → sole contributor to totalElapsedMs
 * - unreadable 1004 (null terminal) ends 02:01:00 → wins lastActivityAt, not elapsed
 */
const GAMMA_TOTAL_ELAPSED_MS = 20_000;
const GAMMA_LAST_ACTIVITY_AT = "2026-08-02T02:01:00.000Z";

const ABSENT: AnalystOptionalMetricNumber = { status: "absent" };
const present = (value: number): AnalystOptionalMetricNumber => ({
  status: "present",
  value,
});
const presentAt = (at: string): AnalystOptionalTimestamp => ({
  status: "present",
  at,
});

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "analyst-c1-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "analyst-c1-home-"));
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

function assertNoZeroOrInfinity(metric: AnalystOptionalMetricNumber): void {
  if (metric.status === "absent") return;
  assert.equal(Number.isFinite(metric.value), true, "msPerKLines must be finite when present");
  // Present LOC path never encodes the forbidden 0/∞ stand-ins for 空缺.
  assert.notEqual(metric.value, 0);
  assert.notEqual(metric.value, Number.POSITIVE_INFINITY);
  assert.notEqual(metric.value, Number.NEGATIVE_INFINITY);
}

function expectedRow(input: {
  readonly projectRoot: string;
  readonly totalElapsedMs: number;
  readonly changedLines: AnalystOptionalMetricNumber;
  readonly msPerKLines: AnalystOptionalMetricNumber;
  readonly lastActivityAt: AnalystOptionalTimestamp;
  readonly issueNumber?: number;
}): AnalystLibraryIndexRow {
  const projectRoot = physicalPathIdentity(input.projectRoot);
  return {
    bookKey: `root:${projectRoot}`,
    projectRoot,
    totalElapsedMs: input.totalElapsedMs,
    changedLines: input.changedLines,
    msPerKLines: input.msPerKLines,
    lastActivityAt: input.lastActivityAt,
    ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
  };
}

// 太史 C1 sweep——页与索引写路径家族（#420 整改拆分第二片）。

test("analyst changedLines rejects non-finite negatives at issue and sweep boundaries", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      await assert.rejects(
        () =>
          runAnalyst({
            mode: "issue",
            projectRoot: ISSUE_ALPHA,
            changedLines: -3,
          }),
        /changedLines must be a finite non-negative number/,
      );
      await assert.rejects(
        () =>
          runAnalyst({
            mode: "issue",
            projectRoot: ISSUE_ALPHA,
            changedLines: Number.POSITIVE_INFINITY,
          }),
        /changedLines must be a finite non-negative number/,
      );
      await assert.rejects(
        () =>
          runAnalyst({
            mode: "sweep",
            mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: -1 }],
          }),
        /changedLines must be a finite non-negative number/,
      );
      // 0 remains lawful typed 空缺.
      const zero = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
        changedLines: 0,
      });
      assert.deepEqual(zero.page.changedLines, { status: "absent" });
      assert.deepEqual(zero.page.msPerKLines, { status: "absent" });
    });
  });
});
test("analyst session span with inverted timestamps is page-local unreadable", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const sessionPath = join(
        home,
        ".ak-roles",
        "books",
        "fixture-book-c1",
        "runs",
        `${C1_ALPHA_RUN}@coder`,
        "session",
        "session.jsonl",
      );
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "s-c1-a1-bad",
            timestamp: "2026-08-02T00:00:40.000Z",
            cwd: ISSUE_ALPHA,
          }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: "2026-08-02T00:00:40.000Z",
            message: {
              role: "assistant",
              timestamp: "2026-08-02T00:00:40.000Z",
              content: [],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "m2",
            parentId: "m1",
            timestamp: "2026-08-02T00:00:00.000Z",
            message: {
              role: "assistant",
              timestamp: "2026-08-02T00:00:00.000Z",
              content: [],
            },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
      });
      assert.equal(result.page.legs.length, 0);
      assert.equal(result.page.totalElapsedMs, 0);
      assert.equal(result.page.unreadableCount, 1);
      const entry = result.page.unreadable[0]!;
      assert.equal(entry.runId, C1_ALPHA_RUN);
      assert.deepEqual(entry.missingSources, ["session-timeline"]);
      assert.match(entry.reason, /end is earlier than start/i);
      // Must not surface negative/NaN wall clocks on the page envelope.
      assert.equal(Number.isFinite(result.page.totalElapsedMs), true);
      assert.ok(result.page.totalElapsedMs >= 0);
    });
  });
});
test("analyst live run-state is not classified as terminal no-receipt", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        "fixture-book-c1",
        "runs",
        `${C1_ALPHA_RUN}@coder`,
      );
      await rm(join(runDir, "artifacts"), { recursive: true, force: true });
      await writeFile(
        join(runDir, "run-state.json"),
        `${JSON.stringify({
          runId: C1_ALPHA_RUN,
          role: "coder",
          state: "running",
          bookKey: "fixture-book-c1",
          projectRoot: ISSUE_ALPHA,
          sessionDirectory: join(runDir, "session"),
          sessionFile: join(runDir, "session", "session.jsonl"),
          runDirectory: runDir,
          admittedRequestPath: join(runDir, "invocation.json"),
        }, null, 2)}\n`,
        "utf8",
      );

      const result = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
      });
      // Live run is omitted entirely — not a leg, not unreadable death.
      assert.equal(
        result.page.legs.some((leg) => leg.runId === C1_ALPHA_RUN),
        false,
      );
      assert.equal(
        result.page.unreadable.some((entry) => entry.runId === C1_ALPHA_RUN),
        false,
      );
      assert.equal(result.page.totalElapsedMs, 0);
      const page = result.page as AnalystIssueMetricsPage & {
        acceptanceSuccessRework?: {
          byRole: readonly {
            role: string;
            noReceiptCount: number;
            appearanceLaneCount: number;
          }[];
        };
      };
      const coder = page.acceptanceSuccessRework?.byRole.find((r) => r.role === "coder");
      assert.equal(coder?.noReceiptCount ?? 0, 0);
      assert.equal(coder?.appearanceLaneCount ?? 0, 0);
    });
  });
});
test("analyst reads publisher durable error.settlement fallback as terminal failure", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const runDir = join(
        home,
        ".ak-roles",
        "books",
        "fixture-book-c1",
        "runs",
        `${C1_ALPHA_RUN}@coder`,
      );
      await rm(join(runDir, "artifacts"), { recursive: true, force: true });
      await writeFile(
        join(runDir, "error.settlement.json"),
        `${JSON.stringify({
          kind: "error",
          role: "coder",
          runId: C1_ALPHA_RUN,
          cause: "provider",
          diagnostic: "settled fallback failure",
        }, null, 2)}\n`,
        "utf8",
      );

      const result = await runAnalyst({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
      });
      assert.equal(
        result.page.legs.some((leg) => leg.runId === C1_ALPHA_RUN),
        true,
        "run with durable fallback error must remain readable",
      );
      const page = result.page as AnalystIssueMetricsPage & {
        roundTimeline?: {
          lanes: readonly {
            lane: string;
            rows: readonly {
              kind: string;
              runId?: string;
              terminal?: { kind: string; channel?: string };
            }[];
          }[];
        };
      };
      const row = page.roundTimeline?.lanes
        .flatMap((lane) => lane.rows)
        .find((entry) => entry.kind === "run" && entry.runId === C1_ALPHA_RUN);
      assert.ok(row, "timeline must keep the fallback-error run");
      assert.equal(row.terminal?.kind, "death");
      assert.equal(row.terminal?.channel, "error");
    });
  });
});
