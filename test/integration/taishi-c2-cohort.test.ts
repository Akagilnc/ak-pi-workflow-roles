/**
 * #330 taishi-C2 — cohort contrast output tracer.
 *
 * Typed input = two groups {groupLabel, issues[]} → join library index by
 * issue number → load persisted issue pages → side-by-side per-role
 * convergence rounds (w/ median) + rework ratio + first-pass rate + success
 * rate + leg wall-clock median.
 * Ratio metrics merge numerators/denominators across the group's present issues;
 * missing index row → typed vacancy entry; zero denominator → typed vacancy.
 * Index rows come from the real issue-mode entry (no hand-written index assembly).
 * Index hit + page missing → #338 compute-if-missing (sole kernel) restores page;
 * index miss alone remains typed vacancy. Compute failure stays loud (not absent).
 * C2 fixture runs use exclusive runId segment 019ff000-2xxx and carry typed
 * ticketNumbers matching their issue numbers — T4 revised (#413 r2 U2 owner
 * decision): cohort issueNumber IS the ticketNumber, so a cache-miss recompute
 * admits only invocation.ticketNumber-matching runs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import type {
  TaishiCohortGroupResult,
  TaishiCohortOptionalMetric,
  TaishiCohortRoleStats,
} from "../../src/taishi-cohort.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

const ISSUE_201_ROOT = "/taishi-fixture/c2-issue-201";
const ISSUE_202_ROOT = "/taishi-fixture/c2-issue-202";
const ISSUE_203_ROOT = "/taishi-fixture/c2-issue-203";

/** #412: cohort library face requires explicit bookKey per issue (no cross-book find). */
function issueRef(projectRoot: string, issueNumber: number) {
  return {
    bookKey: `root:${physicalPathIdentity(projectRoot)}`,
    issueNumber,
  };
}

/** Vacancy refs still need a book scope — synthetic root of a non-indexed path. */
function absentRef(issueNumber: number) {
  return {
    bookKey: `root:${physicalPathIdentity(`/taishi-fixture/c2-absent-${issueNumber}`)}`,
    issueNumber,
  };
}

const RUN_201_CODER_1 = "019ff000-2001-7000-8000-0000000002a1";
const RUN_201_CODER_2 = "019ff000-2002-7000-8000-0000000002a2";
const RUN_201_JUDGE = "019ff000-2003-7000-8000-0000000002a3";
const RUN_202_CODER = "019ff000-2004-7000-8000-0000000002b4";
const RUN_203_CODER = "019ff000-2005-7000-8000-0000000002c5";
const RUN_203_JUDGE = "019ff000-2006-7000-8000-0000000002c6";

/**
 * Hand oracle (ticket #330 cohort 合同钉版):
 *
 * Issue 201 (book c2-a):
 *   coder 2001 completed wall 60_000 @ ordinal 1 (first-pass)
 *   coder 2002 completed wall 30_000 @ ordinal 2 (rework)
 *   judge 2003 converged wall 10_000 @ ordinal 1 (first-pass)
 *   coder: rounds=2 firstPass+1 success 2/2
 *   judge: rounds=1 firstPass+1 success 1/1
 *   reworkWall=30_000 totalWall=100_000
 *   walls=[60000,30000,10000]
 *
 * Issue 202 (book c2-b):
 *   coder 2004 refused wall 20_000 @ ordinal 1 (first-pass accepted)
 *   coder: rounds=1 firstPass+1 success 0/1
 *   reworkWall=0 totalWall=20_000
 *   walls=[20000]
 *
 * Issue 203 (book c2-c):
 *   coder 2005 completed wall 40_000 @ ordinal 1
 *   judge 2006 converged wall 8_000 @ ordinal 1
 *   coder: rounds=1 firstPass+1 success 1/1
 *   judge: rounds=1 firstPass+1 success 1/1
 *   reworkWall=0 totalWall=48_000
 *   walls=[40000,8000]
 *
 * Issue 204: no index row → typed vacancy.
 *
 * Group "before" = [201, 202]:
 *   coder rounds=[2,1] median=1.5
 *         firstPass=2/2=1  success=2/3
 *   judge rounds=[1] median=1
 *         firstPass=1/1=1  success=1/1=1
 *   rework=30000/120000=0.25
 *   walls=[60000,30000,10000,20000] sorted=[10000,20000,30000,60000]
 *         median=(20000+30000)/2=25000
 *
 * Group "after" = [203, 204]:
 *   issues: 203 present, 204 absent
 *   coder rounds=[1] median=1 firstPass=1 success=1
 *   judge rounds=[1] median=1 firstPass=1 success=1
 *   rework=0/48000=0
 *   walls=[40000,8000] median=(40000+8000)/2=24000
 */
const ABSENT: TaishiCohortOptionalMetric = { status: "absent" };
const present = (value: number): TaishiCohortOptionalMetric => ({
  status: "present",
  value,
});

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-c2-business-"));
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
  const home = await mkdtemp(join(tmpdir(), "taishi-c2-home-"));
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

function roleStats(
  group: TaishiCohortGroupResult,
  role: string,
): TaishiCohortRoleStats | undefined {
  return group.byRole.find((entry) => entry.role === role);
}

test("taishi C2 cohort: side-by-side group metrics join index by issueNumber; vacancy + merged ratios", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      // Persist issue pages (issue mode) carrying typed issueNumber;
      // real entry also maintains the unique issueNumber→projectRoot index rows.
      const page201 = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_201_ROOT,
        issueNumber: 201,
      });
      const page202 = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_202_ROOT,
        issueNumber: 202,
      });
      const page203 = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_203_ROOT,
        issueNumber: 203,
      });

      assert.equal(page201.mode, "issue");
      assert.equal(page201.page.issueNumber, 201);
      assert.equal(page202.page.issueNumber, 202);
      assert.equal(page203.page.issueNumber, 203);

      // Sanity: C2-exclusive runIds landed on the right pages.
      assert.deepEqual(
        page201.page.legs.map((leg) => leg.runId).sort(),
        [RUN_201_CODER_1, RUN_201_CODER_2, RUN_201_JUDGE].sort(),
      );
      assert.deepEqual(
        page202.page.legs.map((leg) => leg.runId),
        [RUN_202_CODER],
      );
      assert.deepEqual(
        page203.page.legs.map((leg) => leg.runId).sort(),
        [RUN_203_CODER, RUN_203_JUDGE].sort(),
      );

      // Library index rows were produced by the issue-mode entry above
      // (issueNumber→projectRoot). No hand-written index; 204 has no row.
      const result = await runTaishi({
        mode: "cohort",
        groups: [
          {
            groupLabel: "before",
            issues: [issueRef(ISSUE_201_ROOT, 201), issueRef(ISSUE_202_ROOT, 202)],
          },
          {
            groupLabel: "after",
            issues: [issueRef(ISSUE_203_ROOT, 203), absentRef(204)],
          },
        ],
      });

      assert.equal(result.mode, "cohort");
      assert.equal(result.groups.length, 2);

      const before = result.groups[0]!;
      const after = result.groups[1]!;

      // Group labels retained as typed input.
      assert.equal(before.groupLabel, "before");
      assert.equal(after.groupLabel, "after");

      // Issue join: present rows vs typed vacancy (204 missing from index).
      assert.deepEqual(before.issues, [
        {
          issueNumber: 201,
          status: "present",
          bookKey: `root:${physicalPathIdentity(ISSUE_201_ROOT)}`,
          projectRoot: physicalPathIdentity(ISSUE_201_ROOT),
        },
        {
          issueNumber: 202,
          status: "present",
          bookKey: `root:${physicalPathIdentity(ISSUE_202_ROOT)}`,
          projectRoot: physicalPathIdentity(ISSUE_202_ROOT),
        },
      ]);
      assert.deepEqual(after.issues, [
        {
          issueNumber: 203,
          status: "present",
          bookKey: `root:${physicalPathIdentity(ISSUE_203_ROOT)}`,
          projectRoot: physicalPathIdentity(ISSUE_203_ROOT),
        },
        { issueNumber: 204, status: "absent", bookKey: absentRef(204).bookKey },
      ]);

      // ---- before group hand values ----
      const beforeCoder = roleStats(before, "coder");
      assert.ok(beforeCoder, "before lists coder");
      assert.deepEqual(beforeCoder.convergenceRounds, [2, 1]);
      assert.deepEqual(beforeCoder.convergenceRoundsMedian, present(1.5));
      assert.deepEqual(beforeCoder.firstPassRate, present(1));
      assert.deepEqual(beforeCoder.successRate, present(2 / 3));

      const beforeJudge = roleStats(before, "judge");
      assert.ok(beforeJudge, "before lists judge");
      assert.deepEqual(beforeJudge.convergenceRounds, [1]);
      assert.deepEqual(beforeJudge.convergenceRoundsMedian, present(1));
      assert.deepEqual(beforeJudge.firstPassRate, present(1));
      assert.deepEqual(beforeJudge.successRate, present(1));

      assert.deepEqual(before.reworkRatio, present(0.25));
      assert.deepEqual(before.medianWallMs, present(25_000));

      // ---- after group hand values (204 vacant, does not contribute) ----
      const afterCoder = roleStats(after, "coder");
      assert.ok(afterCoder, "after lists coder");
      assert.deepEqual(afterCoder.convergenceRounds, [1]);
      assert.deepEqual(afterCoder.convergenceRoundsMedian, present(1));
      assert.deepEqual(afterCoder.firstPassRate, present(1));
      assert.deepEqual(afterCoder.successRate, present(1));

      const afterJudge = roleStats(after, "judge");
      assert.ok(afterJudge, "after lists judge");
      assert.deepEqual(afterJudge.convergenceRounds, [1]);
      assert.deepEqual(afterJudge.convergenceRoundsMedian, present(1));
      assert.deepEqual(afterJudge.firstPassRate, present(1));
      assert.deepEqual(afterJudge.successRate, present(1));

      assert.deepEqual(after.reworkRatio, present(0));
      assert.deepEqual(after.medianWallMs, present(24_000));

      // Cohort is a query product — no second parse of runs, no page rewrite.
      // Re-run yields identical typed output (pure read of persisted pages/index).
      const again = await runTaishi({
        mode: "cohort",
        groups: [
          {
            groupLabel: "before",
            issues: [issueRef(ISSUE_201_ROOT, 201), issueRef(ISSUE_202_ROOT, 202)],
          },
          {
            groupLabel: "after",
            issues: [issueRef(ISSUE_203_ROOT, 203), absentRef(204)],
          },
        ],
      });
      assert.deepEqual(again, result);
    });
  });
});

test("taishi C2 cohort: all-absent group yields typed vacancy aggregates (no 0/∞ stand-in)", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      // No issue-mode production → no index rows → every issue is vacancy.
      const result = await runTaishi({
        mode: "cohort",
        groups: [
          { groupLabel: "left", issues: [absentRef(901), absentRef(902)] },
          { groupLabel: "right", issues: [absentRef(903)] },
        ],
      });

      assert.equal(result.mode, "cohort");
      const left = result.groups[0]!;
      const right = result.groups[1]!;

      assert.equal(left.groupLabel, "left");
      assert.deepEqual(left.issues, [
        { issueNumber: 901, status: "absent", bookKey: absentRef(901).bookKey },
        { issueNumber: 902, status: "absent", bookKey: absentRef(902).bookKey },
      ]);
      assert.deepEqual(left.byRole, []);
      assert.deepEqual(left.reworkRatio, ABSENT);
      assert.deepEqual(left.medianWallMs, ABSENT);

      assert.equal(right.groupLabel, "right");
      assert.deepEqual(right.issues, [
        { issueNumber: 903, status: "absent", bookKey: absentRef(903).bookKey },
      ]);
      assert.deepEqual(right.byRole, []);
      assert.deepEqual(right.reworkRatio, ABSENT);
      assert.deepEqual(right.medianWallMs, ABSENT);
    });
  });
});

test("taishi C2 cohort: index hit + page missing recomputes via sole kernel (not washed to absent)", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      // Real entry produces page + unique index row.
      const produced = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_201_ROOT,
        issueNumber: 201,
      });
      const expectedWall = produced.page.totalElapsedMs;
      const expectedRuns = produced.page.legs.map((leg) => leg.runId).sort();
      // Remove page, keep index row — #338 compute-if-missing must restore it.
      await rm(produced.pagePath);

      const result = await runTaishi({
        mode: "cohort",
        groups: [
          { groupLabel: "left", issues: [issueRef(ISSUE_201_ROOT, 201)] },
          { groupLabel: "right", issues: [absentRef(999)] },
        ],
      });

      assert.equal(result.mode, "cohort");
      assert.deepEqual(result.groups[0]!.issues, [
        {
          issueNumber: 201,
          status: "present",
          bookKey: `root:${physicalPathIdentity(ISSUE_201_ROOT)}`,
          projectRoot: physicalPathIdentity(ISSUE_201_ROOT),
        },
      ]);
      // Right group index-miss stays typed vacancy (not a compute target);
      // the vacancy carries the requested bookKey (U4) so cross-book same
      // numbers stay self-describing.
      assert.deepEqual(result.groups[1]!.issues, [
        { issueNumber: 999, status: "absent", bookKey: absentRef(999).bookKey },
      ]);
      // Page restored through sole writer entry.
      const restored = JSON.parse(
        await readFile(produced.pagePath, "utf8"),
      ) as { totalElapsedMs: number; legs: readonly { runId: string }[] };
      assert.equal(restored.totalElapsedMs, expectedWall);
      assert.deepEqual(
        restored.legs.map((leg) => leg.runId).sort(),
        expectedRuns,
      );
    });
  });
});
