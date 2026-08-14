/**
 * #329 taishi-C1 — sweep mode + library index page tracer.
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
import { runTaishi } from "../../src/taishi-entry.ts";
import {
  buildTaishiLibraryIndexPage,
  mergeTaishiLibraryIndexRows,
  taishiLibraryIndexPath,
  writeTaishiLibraryIndexPage,
  type TaishiLibraryIndexPage,
  type TaishiLibraryIndexRow,
} from "../../src/taishi-index.ts";
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
  type TaishiOptionalMetricNumber,
  type TaishiOptionalTimestamp,
} from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

/** Shared board (B-wave) — totalElapsedMs/lastActivityAt hand-known. */
const ISSUE_DEMO = "/taishi-fixture/issue-demo";
/** C1-owned fixture — runId 019ff000-1001, wall 40_000. */
const ISSUE_ALPHA = "/taishi-fixture/c1-issue-alpha";
/** C1-owned fixture — runId 019ff000-1002, wall 10_000. */
const ISSUE_BETA = "/taishi-fixture/c1-issue-beta";
/**
 * C1-owned negative: readable earlier + newer terminal-unreadable with later end-frame.
 * runIds 019ff000-1003 / 019ff000-1004.
 */
const ISSUE_GAMMA = "/taishi-fixture/c1-issue-gamma";

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

const ABSENT: TaishiOptionalMetricNumber = { status: "absent" };
const present = (value: number): TaishiOptionalMetricNumber => ({
  status: "present",
  value,
});
const presentAt = (at: string): TaishiOptionalTimestamp => ({
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
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-c1-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "taishi-c1-home-"));
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

function assertNoZeroOrInfinity(metric: TaishiOptionalMetricNumber): void {
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
  readonly changedLines: TaishiOptionalMetricNumber;
  readonly msPerKLines: TaishiOptionalMetricNumber;
  readonly lastActivityAt: TaishiOptionalTimestamp;
}): TaishiLibraryIndexRow {
  return {
    projectRoot: physicalPathIdentity(input.projectRoot),
    totalElapsedMs: input.totalElapsedMs,
    changedLines: input.changedLines,
    msPerKLines: input.msPerKLines,
    lastActivityAt: input.lastActivityAt,
  };
}

test("taishi C1 sweep: backfills issue pages, maintains index rows, LOC present/absent, idempotent re-run", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      const indexPath = taishiLibraryIndexPath(ledgerHome);

      // LOC present on alpha: 500 lines → msPerK = 40000 / (500/1000) = 80000.
      // LOC omitted on beta → typed 空缺 (not 0/∞).
      // LOC=0 on demo → typed 空缺 (缺省或为 0).
      const first = await runTaishi({
        mode: "sweep",
        mergedPullRequests: [
          { projectRoot: ISSUE_DEMO, changedLines: 0 },
          { projectRoot: ISSUE_ALPHA, changedLines: 500 },
          { projectRoot: ISSUE_BETA },
        ],
      });

      assert.equal(first.mode, "sweep");
      assert.equal(first.indexPath, indexPath);
      assert.equal(first.index.kind, "taishi-library-index");
      assert.equal(first.issuePages.length, 3);

      // Each issue → exactly one page path under taishi/issues/.
      const issueDir = join(ledgerHome, "taishi", "issues");
      const pageFiles = (await readdir(issueDir)).filter((n) => n.endsWith(".json")).sort();
      assert.equal(pageFiles.length, 3, "sweep writes one page per issue");

      const demoPath = taishiIssuePagePath(ledgerHome, ISSUE_DEMO);
      const alphaPath = taishiIssuePagePath(ledgerHome, ISSUE_ALPHA);
      const betaPath = taishiIssuePagePath(ledgerHome, ISSUE_BETA);
      // One canonical page file per issue key — no duplicates on disk.
      assert.deepEqual(
        new Set(pageFiles),
        new Set([
          demoPath.slice(issueDir.length + 1),
          alphaPath.slice(issueDir.length + 1),
          betaPath.slice(issueDir.length + 1),
        ]),
      );

      // Issue pages carry efficiency envelope (caller LOC retained / absent).
      const demoPage = JSON.parse(await readFile(demoPath, "utf8")) as TaishiIssueMetricsPage;
      const alphaPage = JSON.parse(await readFile(alphaPath, "utf8")) as TaishiIssueMetricsPage;
      const betaPage = JSON.parse(await readFile(betaPath, "utf8")) as TaishiIssueMetricsPage;

      assert.equal(demoPage.totalElapsedMs, DEMO_TOTAL_ELAPSED_MS);
      assert.deepEqual(demoPage.changedLines, ABSENT);
      assert.deepEqual(demoPage.msPerKLines, ABSENT);
      assert.deepEqual(demoPage.lastActivityAt, presentAt(DEMO_LAST_ACTIVITY_AT));
      assertNoZeroOrInfinity(demoPage.msPerKLines);

      assert.equal(alphaPage.totalElapsedMs, ALPHA_TOTAL_ELAPSED_MS);
      assert.deepEqual(alphaPage.changedLines, present(500));
      assert.deepEqual(alphaPage.msPerKLines, present(80_000));
      assert.deepEqual(alphaPage.lastActivityAt, presentAt(ALPHA_LAST_ACTIVITY_AT));
      assert.equal(alphaPage.legs[0]?.runId, C1_ALPHA_RUN);

      assert.equal(betaPage.totalElapsedMs, BETA_TOTAL_ELAPSED_MS);
      assert.deepEqual(betaPage.changedLines, ABSENT);
      assert.deepEqual(betaPage.msPerKLines, ABSENT);
      assert.deepEqual(betaPage.lastActivityAt, presentAt(BETA_LAST_ACTIVITY_AT));
      assert.equal(betaPage.legs[0]?.runId, C1_BETA_RUN);
      assertNoZeroOrInfinity(betaPage.msPerKLines);

      // Index rows: self-sufficient; stable sort by projectRoot identity.
      const expectedRows: TaishiLibraryIndexRow[] = [
        expectedRow({
          projectRoot: ISSUE_ALPHA,
          totalElapsedMs: ALPHA_TOTAL_ELAPSED_MS,
          changedLines: present(500),
          msPerKLines: present(80_000),
          lastActivityAt: presentAt(ALPHA_LAST_ACTIVITY_AT),
        }),
        expectedRow({
          projectRoot: ISSUE_BETA,
          totalElapsedMs: BETA_TOTAL_ELAPSED_MS,
          changedLines: ABSENT,
          msPerKLines: ABSENT,
          lastActivityAt: presentAt(BETA_LAST_ACTIVITY_AT),
        }),
        expectedRow({
          projectRoot: ISSUE_DEMO,
          totalElapsedMs: DEMO_TOTAL_ELAPSED_MS,
          changedLines: ABSENT,
          msPerKLines: ABSENT,
          lastActivityAt: presentAt(DEMO_LAST_ACTIVITY_AT),
        }),
      ].sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));

      assert.deepEqual(first.index.rows, expectedRows);
      for (const row of first.index.rows) {
        assertNoZeroOrInfinity(row.msPerKLines);
      }

      const indexOnDisk = JSON.parse(
        await readFile(indexPath, "utf8"),
      ) as TaishiLibraryIndexPage;
      assert.deepEqual(indexOnDisk, first.index);

      // Idempotent re-run: same issue still one page; content equivalent.
      const firstDemoBytes = await readFile(demoPath, "utf8");
      const firstAlphaBytes = await readFile(alphaPath, "utf8");
      const firstBetaBytes = await readFile(betaPath, "utf8");
      const firstIndexBytes = await readFile(indexPath, "utf8");

      const second = await runTaishi({
        mode: "sweep",
        mergedPullRequests: [
          { projectRoot: ISSUE_DEMO, changedLines: 0 },
          { projectRoot: ISSUE_ALPHA, changedLines: 500 },
          { projectRoot: ISSUE_BETA },
        ],
      });

      const pageFilesAgain = (await readdir(issueDir))
        .filter((n) => n.endsWith(".json"))
        .sort();
      assert.equal(pageFilesAgain.length, 3, "re-sweep must not duplicate issue pages");
      assert.deepEqual(pageFilesAgain, pageFiles);

      assert.deepEqual(second.index, first.index);
      assert.deepEqual(second.issuePages.map((p) => p.page), first.issuePages.map((p) => p.page));
      assert.equal(await readFile(demoPath, "utf8"), firstDemoBytes);
      assert.equal(await readFile(alphaPath, "utf8"), firstAlphaBytes);
      assert.equal(await readFile(betaPath, "utf8"), firstBetaBytes);
      assert.equal(await readFile(indexPath, "utf8"), firstIndexBytes);
    });
  });
});

test("taishi C1 issue-mode optional LOC: present yields msPerK; omit yields typed 空缺", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      // Present LOC on C1 alpha: 1000 lines → msPerK = 40000 / 1 = 40000.
      const withLoc = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
        changedLines: 1000,
      });
      assert.equal(withLoc.mode, "issue");
      assert.equal(withLoc.page.totalElapsedMs, ALPHA_TOTAL_ELAPSED_MS);
      assert.deepEqual(withLoc.page.changedLines, present(1000));
      assert.deepEqual(withLoc.page.msPerKLines, present(40_000));
      assert.deepEqual(withLoc.page.lastActivityAt, presentAt(ALPHA_LAST_ACTIVITY_AT));
      assert.equal(withLoc.page.legs[0]?.runId, C1_ALPHA_RUN);

      // Omit LOC → typed 空缺 (never 0/∞ stand-in).
      const withoutLoc = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_BETA,
      });
      assert.deepEqual(withoutLoc.page.changedLines, ABSENT);
      assert.deepEqual(withoutLoc.page.msPerKLines, ABSENT);
      assertNoZeroOrInfinity(withoutLoc.page.msPerKLines);
      assert.equal(withoutLoc.page.totalElapsedMs, BETA_TOTAL_ELAPSED_MS);
      // Issue mode does not maintain the library index.
      assert.equal("index" in withoutLoc, false);
    });
  });
});

test("taishi C1 sweep: unreadable later end-frame still wins lastActivityAt; elapsed excludes it", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      const indexPath = taishiLibraryIndexPath(ledgerHome);

      const result = await runTaishi({
        mode: "sweep",
        mergedPullRequests: [{ projectRoot: ISSUE_GAMMA, changedLines: 100 }],
      });

      assert.equal(result.mode, "sweep");
      assert.equal(result.issuePages.length, 1);
      const page = result.issuePages[0]!.page;

      // Readable-only elapsed; unreadable null-terminal excluded from legs/elapsed.
      assert.equal(page.totalElapsedMs, GAMMA_TOTAL_ELAPSED_MS);
      assert.deepEqual(page.legs.map((leg) => leg.runId), [C1_GAMMA_READABLE_RUN]);
      assert.equal(page.unreadableCount, 1);
      assert.equal(page.unreadable[0]?.runId, C1_GAMMA_UNREADABLE_RUN);
      assert.deepEqual(page.unreadable[0]?.missingSources, ["terminal-artifact"]);
      assert.deepEqual(page.unreadable[0]?.lastFrameAt, presentAt(GAMMA_LAST_ACTIVITY_AT));

      // PRD ②: lastActivityAt = max end-frame of ALL runs (unreadable available end wins).
      assert.deepEqual(page.lastActivityAt, presentAt(GAMMA_LAST_ACTIVITY_AT));
      assert.deepEqual(page.changedLines, present(100));
      assert.deepEqual(page.msPerKLines, present(200_000)); // 20000 / (100/1000)

      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_GAMMA);
      const onDisk = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.deepEqual(onDisk.lastActivityAt, presentAt(GAMMA_LAST_ACTIVITY_AT));
      assert.equal(onDisk.totalElapsedMs, GAMMA_TOTAL_ELAPSED_MS);

      // Index row projects the same lastActivityAt through sweep → disk.
      assert.equal(result.indexPath, indexPath);
      assert.equal(result.index.rows.length, 1);
      assert.deepEqual(
        result.index.rows[0],
        expectedRow({
          projectRoot: ISSUE_GAMMA,
          totalElapsedMs: GAMMA_TOTAL_ELAPSED_MS,
          changedLines: present(100),
          msPerKLines: present(200_000),
          lastActivityAt: presentAt(GAMMA_LAST_ACTIVITY_AT),
        }),
      );
      const indexOnDisk = JSON.parse(
        await readFile(indexPath, "utf8"),
      ) as TaishiLibraryIndexPage;
      assert.deepEqual(indexOnDisk.rows[0]?.lastActivityAt, presentAt(GAMMA_LAST_ACTIVITY_AT));
      assert.equal(indexOnDisk.rows[0]?.totalElapsedMs, GAMMA_TOTAL_ELAPSED_MS);
    });
  });
});


test("taishi library-index concurrent issue upserts retain both rows", async () => {
  await withBusinessRepo(async () => {
    const home = await mkdtemp(join(tmpdir(), "taishi-c1-lock-home-"));
    try {
      await cp(fixtureHome, join(home, ".ak-roles"), { recursive: true });
      const ledgerHome = join(home, ".ak-roles");
      // Shared old page both children will read before inserting their own row.
      await writeTaishiLibraryIndexPage(
        ledgerHome,
        buildTaishiLibraryIndexPage([
          {
            projectRoot: physicalPathIdentity("/taishi-fixture/c1-lock-seed"),
            issueNumber: 9000,
            totalElapsedMs: 1,
            changedLines: { status: "absent" },
            msPerKLines: { status: "absent" },
            lastActivityAt: { status: "absent" },
          },
        ]),
      );

      const entryHref = JSON.stringify(
        new URL("../../src/taishi-index.ts", import.meta.url).href,
      );
      const topologyHref = JSON.stringify(
        new URL("../../src/activation-ledger-topology.ts", import.meta.url).href,
      );
      const childSource = `
const { mergeTaishiLibraryIndexRows } = await import(${entryHref});
const { physicalPathIdentity } = await import(${topologyHref});
const ledgerHome = process.env.TAISHI_LEDGER_HOME;
const issueNumber = Number(process.env.TAISHI_ISSUE_NUMBER);
const projectRoot = process.env.TAISHI_PROJECT_ROOT;
if (!ledgerHome || !Number.isFinite(issueNumber) || !projectRoot) {
  throw new Error("missing child env");
}
await new Promise((r) => setTimeout(r, 25));
await mergeTaishiLibraryIndexRows(ledgerHome, [{
  projectRoot: physicalPathIdentity(projectRoot),
  issueNumber,
  totalElapsedMs: issueNumber,
  changedLines: { status: "absent" },
  msPerKLines: { status: "absent" },
  lastActivityAt: { status: "absent" },
}]);
`;

      const runChild = (issueNumber: number, projectRoot: string) =>
        new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", childSource],
            {
              cwd: packageRoot,
              env: {
                ...process.env,
                HOME: home,
                TAISHI_LEDGER_HOME: ledgerHome,
                TAISHI_ISSUE_NUMBER: String(issueNumber),
                TAISHI_PROJECT_ROOT: projectRoot,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (status) => resolve({ status, stderr }));
        });

      const [a, b] = await Promise.all([
        runChild(9001, "/taishi-fixture/c1-lock-a"),
        runChild(9002, "/taishi-fixture/c1-lock-b"),
      ]);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);

      const index = JSON.parse(
        await readFile(taishiLibraryIndexPath(ledgerHome), "utf8"),
      ) as TaishiLibraryIndexPage;
      const nums = index.rows
        .map((row) => row.issueNumber)
        .sort((x, y) => (x ?? 0) - (y ?? 0));
      assert.deepEqual(nums, [9000, 9001, 9002]);
      // merge helper remains callable in-process (single coordination seam).
      await mergeTaishiLibraryIndexRows(ledgerHome, []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("taishi changedLines rejects non-finite negatives at issue and sweep boundaries", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      await assert.rejects(
        () =>
          runTaishi({
            mode: "issue",
            projectRoot: ISSUE_ALPHA,
            changedLines: -3,
          }),
        /changedLines must be a finite non-negative number/,
      );
      await assert.rejects(
        () =>
          runTaishi({
            mode: "issue",
            projectRoot: ISSUE_ALPHA,
            changedLines: Number.POSITIVE_INFINITY,
          }),
        /changedLines must be a finite non-negative number/,
      );
      await assert.rejects(
        () =>
          runTaishi({
            mode: "sweep",
            mergedPullRequests: [{ projectRoot: ISSUE_ALPHA, changedLines: -1 }],
          }),
        /changedLines must be a finite non-negative number/,
      );
      // 0 remains lawful typed 空缺.
      const zero = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_ALPHA,
        changedLines: 0,
      });
      assert.deepEqual(zero.page.changedLines, { status: "absent" });
      assert.deepEqual(zero.page.msPerKLines, { status: "absent" });
    });
  });
});

test("taishi session span with inverted timestamps is page-local unreadable", async () => {
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

      const result = await runTaishi({
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

test("taishi live run-state is not classified as terminal no-receipt", async () => {
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

      const result = await runTaishi({
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
      const page = result.page as TaishiIssueMetricsPage & {
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
