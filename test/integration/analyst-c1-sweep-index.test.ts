import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #329 analyst-C1 — sweep mode + library index page tracer.
 *
 * Typed input = merged PR list + LOC → backfill issue pages (idempotent overwrite)
 * and maintain the library index (one self-sufficient row per issue).
 * LOC absent/0 → typed 空缺 for 耗时/千行 (never 0 or Infinity).
 * C1 fixture runs use exclusive runId segment 019ff000-1xxx.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import {
  analystLibraryIndexPath,
  type AnalystLibraryIndexPage,
  type AnalystLibraryIndexRow,
} from "../../src/analyst-index.ts";
import {
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
  type AnalystOptionalMetricNumber,
  type AnalystOptionalTimestamp,
} from "../../src/analyst-page.ts";
import { ANALYST_ISSUE_DEMO as ISSUE_DEMO, C1_ISSUE_ALPHA as ISSUE_ALPHA, C1_ISSUE_BETA as ISSUE_BETA, C1_ALPHA_RUN, withTempHome } from "../helpers/analyst-fixture-kit.ts";

/**
 * C1-owned negative: readable earlier + newer terminal-unreadable with later end-frame.
 * runIds 019ff000-1003 / 019ff000-1004.
 */
const ISSUE_GAMMA = "/analyst-fixture/c1-issue-gamma";

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

test("analyst C1 sweep: backfills issue pages, maintains index rows, LOC present/absent, idempotent re-run", async () => {
  await withTempHome(async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const indexPath = analystLibraryIndexPath(ledgerHome);

    // LOC present on alpha: 500 lines → msPerK = 40000 / (500/1000) = 80000.
    // LOC omitted on beta → typed 空缺 (not 0/∞).
    // LOC=0 on demo → typed 空缺 (缺省或为 0).
    const first = await runAnalyst({
      mode: "sweep",
      mergedPullRequests: [
        { projectRoot: ISSUE_DEMO, changedLines: 0 },
        { projectRoot: ISSUE_ALPHA, changedLines: 500 },
        { projectRoot: ISSUE_BETA },
      ],
    }, { home });

    assert.equal(first.mode, "sweep");
    assert.equal(first.indexPath, indexPath);
    assert.equal(first.index.kind, "analyst-library-index");
    assert.equal(first.issuePages.length, 3);

    // Each issue → exactly one page path under analyst/issues/.
    const issueDir = join(ledgerHome, "analyst", "issues");
    const pageFiles = (await readdir(issueDir)).filter((n) => n.endsWith(".json")).sort();
    assert.equal(pageFiles.length, 3, "sweep writes one page per issue");

    const demoPath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(ISSUE_DEMO)}`, scopeRootIdentity: ISSUE_DEMO });
    const alphaPath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(ISSUE_ALPHA)}`, scopeRootIdentity: ISSUE_ALPHA });
    const betaPath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(ISSUE_BETA)}`, scopeRootIdentity: ISSUE_BETA });
    // One canonical page file per issue key — no duplicates on disk.
    assert.deepEqual(
      new Set(pageFiles),
      new Set([
        basename(demoPath),
        basename(alphaPath),
        basename(betaPath),
      ]),
    );

    const demoPage = first.issuePages.find((p) => p.page.projectRoot === ISSUE_DEMO)?.page;
    const alphaPage = first.issuePages.find((p) => p.page.projectRoot === ISSUE_ALPHA)?.page;
    const betaPage = first.issuePages.find((p) => p.page.projectRoot === ISSUE_BETA)?.page;
    assert.ok(demoPage && alphaPage && betaPage);

    assert.equal(demoPage.totalElapsedMs, DEMO_TOTAL_ELAPSED_MS);
    assert.deepEqual(demoPage.changedLines, ABSENT);
    assert.deepEqual(demoPage.msPerKLines, ABSENT);
    assert.deepEqual(demoPage.lastActivityAt, presentAt(DEMO_LAST_ACTIVITY_AT));

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

    // Index rows: self-sufficient; stable sort by projectRoot identity.
    const expectedRows: AnalystLibraryIndexRow[] = [
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
    ];

    assert.equal(first.index.rows.length, 3);
    for (const expected of expectedRows) {
      const row = first.index.rows.find((r) => r.projectRoot === expected.projectRoot);
      assert.ok(row, `row for ${expected.projectRoot} must exist`);
      assert.deepEqual(row, expected);
    }

    const indexOnDisk = JSON.parse(
      await readFile(indexPath, "utf8"),
    ) as AnalystLibraryIndexPage;
    assert.deepEqual(indexOnDisk, first.index);

    // Idempotent re-run: same issue still one page; content equivalent.
    const firstDemoBytes = await readFile(demoPath, "utf8");
    const firstAlphaBytes = await readFile(alphaPath, "utf8");
    const firstBetaBytes = await readFile(betaPath, "utf8");
    const firstIndexBytes = await readFile(indexPath, "utf8");

    const second = await runAnalyst({
      mode: "sweep",
      mergedPullRequests: [
        { projectRoot: ISSUE_DEMO, changedLines: 0 },
        { projectRoot: ISSUE_ALPHA, changedLines: 500 },
        { projectRoot: ISSUE_BETA },
      ],
    }, { home });

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

    // A later sweep must retain index rows it did not sweep (#329 全库索引页).
    // Asserted through the real runAnalyst entry: a whole-page overwrite on every
    // sweep would drop the carried issue, and the internal merge helper cannot
    // show that — only the entry point's actual write can.
    const carriedProject = join(home, "carried-issue");
    await mkdir(carriedProject, { recursive: true });
    const carried = await runAnalyst(
      { mode: "issue", projectRoot: carriedProject, issueNumber: 4242 },
      { home },
    );
    assert.equal(carried.mode, "issue");

    await runAnalyst(
      { mode: "sweep", mergedPullRequests: [{ projectRoot: ISSUE_BETA }] },
      { home },
    );

    const afterSweep = JSON.parse(
      await readFile(indexPath, "utf8"),
    ) as AnalystLibraryIndexPage;
    const issueNumbers = afterSweep.rows
      .map((row) => row.issueNumber)
      .sort((x, y) => (x ?? 0) - (y ?? 0));
    assert.ok(
      issueNumbers.includes(4242),
      `a sweep must retain an index row it did not sweep: ${JSON.stringify(issueNumbers)}`,
    );
  });
});

test("analyst C1 issue-mode optional LOC: present yields msPerK; omit yields typed 空缺", async () => {
  await withTempHome(async (home) => {
    // Present LOC on C1 alpha: 1000 lines → msPerK = 40000 / 1 = 40000.
    const withLoc = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_ALPHA,
      changedLines: 1000,
    }, { home });
    assert.equal(withLoc.mode, "issue");
    assert.equal(withLoc.page.totalElapsedMs, ALPHA_TOTAL_ELAPSED_MS);
    assert.deepEqual(withLoc.page.changedLines, present(1000));
    assert.deepEqual(withLoc.page.msPerKLines, present(40_000));
    assert.deepEqual(withLoc.page.lastActivityAt, presentAt(ALPHA_LAST_ACTIVITY_AT));
    assert.equal(withLoc.page.legs[0]?.runId, C1_ALPHA_RUN);

    // Omit LOC → typed 空缺 (never 0/∞ stand-in).
    const withoutLoc = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_BETA,
    }, { home });
    assert.deepEqual(withoutLoc.page.changedLines, ABSENT);
    assert.deepEqual(withoutLoc.page.msPerKLines, ABSENT);
    assert.equal(withoutLoc.page.totalElapsedMs, BETA_TOTAL_ELAPSED_MS);
    // Issue mode does not maintain the library index.
    assert.equal("index" in withoutLoc, false);
  });
});

test("analyst C1 sweep: unreadable later end-frame still wins lastActivityAt; elapsed excludes it", async () => {
  await withTempHome(async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const indexPath = analystLibraryIndexPath(ledgerHome);

    const result = await runAnalyst({
      mode: "sweep",
      mergedPullRequests: [{ projectRoot: ISSUE_GAMMA, changedLines: 100 }],
    }, { home });

    assert.equal(result.mode, "sweep");
    assert.equal(result.issuePages.length, 1);
    const page = result.issuePages[0]!.page;

    // Readable-only elapsed; unreadable null-terminal excluded from legs/elapsed.
    assert.equal(page.totalElapsedMs, GAMMA_TOTAL_ELAPSED_MS);
    assert.deepEqual(page.legs.map((leg) => leg.runId), [C1_GAMMA_READABLE_RUN]);
    assert.equal(page.unreadableCount, 1);
    assert.equal(page.unreadable[0]?.runId, C1_GAMMA_UNREADABLE_RUN);
    assert.deepEqual(page.unreadable[0]?.missingSources, ["terminal-artifact"]);
    assert.ok((page.unreadable[0]?.reason ?? "").trim().length > 0);
    assert.deepEqual(page.unreadable[0]?.lastFrameAt, presentAt(GAMMA_LAST_ACTIVITY_AT));

    // PRD ②: lastActivityAt = max end-frame of ALL runs (unreadable available end wins).
    assert.deepEqual(page.lastActivityAt, presentAt(GAMMA_LAST_ACTIVITY_AT));
    assert.deepEqual(page.changedLines, present(100));
    assert.deepEqual(page.msPerKLines, present(200_000)); // 20000 / (100/1000)

    const pagePath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(ISSUE_GAMMA)}`, scopeRootIdentity: ISSUE_GAMMA });
    const onDisk = JSON.parse(await readFile(pagePath, "utf8")) as AnalystIssueMetricsPage;
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
    ) as AnalystLibraryIndexPage;
    assert.deepEqual(indexOnDisk.rows[0]?.lastActivityAt, presentAt(GAMMA_LAST_ACTIVITY_AT));
    assert.equal(indexOnDisk.rows[0]?.totalElapsedMs, GAMMA_TOTAL_ELAPSED_MS);
  });
});
