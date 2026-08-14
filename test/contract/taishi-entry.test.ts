/**
 * #324 taishi-A1 — sole entry seam tracer.
 * Fixture ledger (readable legs across B1/B2/B3 fixtures + 1 damaged session run
 * + 1 other-issue run) → issue-mode typed page with hand-computed legs/unreadable
 * equality, business-repo porcelain unchanged, atomic page replace idempotent.
 * Variants: null terminal artifact → unreadable; taishi symlink into consumer → refuse.
 *
 * Merge note (#326+#327): B2 keeps runId …0005/e5 as the overlap fixture; B3's
 * refused coder fixture is relocated to unique runId …0013/e6 so both cases remain.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ActivationLedgerError,
  physicalPathIdentity,
} from "../../src/activation-ledger-topology.ts";
import { runTaishi } from "../../src/taishi-entry.ts";
import { medianNumber } from "../../src/taishi-median.ts";
import {
  loadTaishiIssueMetricFamilies,
  TAISHI_ISSUE_METRIC_FAMILIES,
  TAISHI_ISSUE_METRIC_FAMILIES_DIR,
} from "../../src/taishi-metric-families.ts";
import type { TaishiAcceptanceSuccessReworkSection } from "../../src/taishi-metric-families/acceptance-success-rework.ts";
import type { TaishiLegWallClockSection } from "../../src/taishi-metric-families/leg-wall-clock.ts";
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";

/** B1 section is contributed by family module — not on the A1/A2 page envelope type. */
type PageWithLegWallClock = TaishiIssueMetricsPage & {
  readonly legWallClock?: TaishiLegWallClockSection;
};

/** B3 section is contributed by family module — not on the A1 page envelope type. */
type PageWithAcceptanceSuccessRework = TaishiIssueMetricsPage & {
  readonly acceptanceSuccessRework?: TaishiAcceptanceSuccessReworkSection;
};

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

const ISSUE_PROJECT_ROOT = "/taishi-fixture/issue-demo";
const BOOK = "fixture-book";
const BOOK_B = "fixture-book-b";
const BOOK_C = "fixture-book-c";
const LEG_A1_RUN = "019ff000-0001-7000-8000-0000000000a1";
const LEG_A1_DIR = `${LEG_A1_RUN}@coder`;
const LEG_B2_RUN = "019ff000-0002-7000-8000-0000000000b2";
/** B2 overlap fixture (completed, wall 100_000) — retains historical e5 runId. */
const LEG_E5_RUN = "019ff000-0005-7000-8000-0000000000e5";
const LEG_F6_RUN = "019ff000-0006-7000-8000-0000000000f6";
const LEG_A7_RUN = "019ff000-0007-7000-8000-0000000000a7";
const LEG_B8_RUN = "019ff000-0008-7000-8000-0000000000b8";
const LEG_C9_RUN = "019ff000-0009-7000-8000-0000000000c9";
const LEG_D0_RUN = "019ff000-000a-7000-8000-0000000000d0";
const LEG_E1_RUN = "019ff000-000b-7000-8000-0000000000e1";
const LEG_F2_RUN = "019ff000-000c-7000-8000-0000000000f2";
const LEG_A3_RUN = "019ff000-000d-7000-8000-0000000000a3";
const LEG_C5_RUN = "019ff000-000e-7000-8000-0000000000c5";
const LEG_D2_RUN = "019ff000-000f-7000-8000-0000000000d2";
const LEG_B1_RUN = "019ff000-0010-7000-8000-0000000000b1";
const LEG_E3_RUN = "019ff000-0011-7000-8000-0000000000e3";
const LEG_F1_RUN = "019ff000-0012-7000-8000-0000000000f1";
/**
 * B3 refused coder fixture — relocated from colliding e5 runId during #326+#327 merge
 * so B2 overlap and B3 refused semantics both remain on the board.
 */
const LEG_E6_RUN = "019ff000-0013-7000-8000-0000000000e6";

/** Hand-computed from fixture (scope = ISSUE_PROJECT_ROOT); sort = book, role, runId. */
const EXPECTED_LEGS = [
  { runId: LEG_A1_RUN, book: BOOK, role: "coder" },
  { runId: LEG_E5_RUN, book: BOOK, role: "coder" },
  { runId: LEG_F6_RUN, book: BOOK, role: "coder" },
  { runId: LEG_A7_RUN, book: BOOK, role: "coder" },
  { runId: LEG_C5_RUN, book: BOOK, role: "coder" },
  { runId: LEG_E6_RUN, book: BOOK, role: "coder" },
  { runId: LEG_C9_RUN, book: BOOK, role: "collector" },
  { runId: LEG_A3_RUN, book: BOOK, role: "collector" },
  { runId: LEG_D0_RUN, book: BOOK, role: "doctor" },
  { runId: LEG_F2_RUN, book: BOOK, role: "fixer" },
  { runId: LEG_B2_RUN, book: BOOK, role: "judge" },
  { runId: LEG_D2_RUN, book: BOOK, role: "judge" },
  { runId: LEG_E3_RUN, book: BOOK, role: "judge" },
  { runId: LEG_E1_RUN, book: BOOK, role: "merger" },
  { runId: LEG_B8_RUN, book: BOOK, role: "reviewer" },
  { runId: LEG_B1_RUN, book: BOOK_B, role: "coder" },
  { runId: LEG_F1_RUN, book: BOOK_C, role: "coder" },
] as const;

const EXPECTED_UNREADABLE = [
  {
    runId: "019ff000-0003-7000-8000-0000000000c3",
    book: BOOK,
    missingSources: ["session-timeline"] as const,
  },
] as const;

/**
 * B1 leg-wall-clock hand values from fixture readable legs only (B1+B2+B3 board).
 * Walls (ms): e5=100000, a1=60000, f1=25000, a7=20000, b1=15000, c5=12000,
 * e6=10000, f2=9000, b2=8000, e1=7000, c9=6000, d2=6000, f6=5000, e3=4000,
 * b8=4000, a3=3000, d0=3000.
 * Ranking wall-clock desc (ties: book, role, runId); median odd-sample middle=8000;
 * total = Σ walls = 297000. Damaged/out-of-scope runs never enter (A1 contract).
 */
const EXPECTED_LEG_WALL_CLOCK = {
  kind: "taishi-leg-wall-clock",
  ranking: [
    { runId: LEG_E5_RUN, book: BOOK, role: "coder", wallMs: 100_000 },
    { runId: LEG_A1_RUN, book: BOOK, role: "coder", wallMs: 60_000 },
    { runId: LEG_F1_RUN, book: BOOK_C, role: "coder", wallMs: 25_000 },
    { runId: LEG_A7_RUN, book: BOOK, role: "coder", wallMs: 20_000 },
    { runId: LEG_B1_RUN, book: BOOK_B, role: "coder", wallMs: 15_000 },
    { runId: LEG_C5_RUN, book: BOOK, role: "coder", wallMs: 12_000 },
    { runId: LEG_E6_RUN, book: BOOK, role: "coder", wallMs: 10_000 },
    { runId: LEG_F2_RUN, book: BOOK, role: "fixer", wallMs: 9_000 },
    { runId: LEG_B2_RUN, book: BOOK, role: "judge", wallMs: 8_000 },
    { runId: LEG_E1_RUN, book: BOOK, role: "merger", wallMs: 7_000 },
    { runId: LEG_C9_RUN, book: BOOK, role: "collector", wallMs: 6_000 },
    { runId: LEG_D2_RUN, book: BOOK, role: "judge", wallMs: 6_000 },
    { runId: LEG_F6_RUN, book: BOOK, role: "coder", wallMs: 5_000 },
    { runId: LEG_E3_RUN, book: BOOK, role: "judge", wallMs: 4_000 },
    { runId: LEG_B8_RUN, book: BOOK, role: "reviewer", wallMs: 4_000 },
    { runId: LEG_A3_RUN, book: BOOK, role: "collector", wallMs: 3_000 },
    { runId: LEG_D0_RUN, book: BOOK, role: "doctor", wallMs: 3_000 },
  ],
  medianWallMs: 8_000,
  totalElapsedMs: 297_000,
} as const;

/**
 * B3 hand oracle (ticket #327 + PRD #298 r8 票面补正 + 施工审 r3),
 * recomputed after #326+#327 merge kept B2 e5 overlap (completed/100s) and
 * relocated B3 refused fixture to e6 (refused/10s).
 *
 * Walls (ms): a1=60000, e5=100000, e6=10000, f6=5000, a7=20000, c5=12000,
 * b2=8000, d2=6000, e3=4000, b8=4000, c9=6000, d0=3000, e1=7000, f2=9000,
 * a3=3000, b1=15000, f1=25000.
 * totalWall=297000;
 * rework={e5,e6,f6,a7,c5,a3,d2,e3}=100000+10000+5000+20000+12000+3000+6000+4000=160000;
 * ratio=160000/297000.
 *
 * coder: accepted={a1,e5,e6,f6,c5,b1}=6; successEligible={a1,e5,e6,c5,b1}=5
 *   (planned f6 out; no-receipt a7+f1 out); success={a1,e5,b1}=3; rate=3/5;
 *   noReceipt={a7,f1}=2;
 *   lanes={fixture-book,fixture-book-b,fixture-book-c}=3;
 *   first accepted on book+book-b only → firstPass=2/3;
 *   rounds books-sorted=[6,1,1]; median=1.
 * judge: b2 converged + d2 continue + e3 escalate — all accepted+success;
 *   rounds=[3] median=3; firstPass=1/1.
 * collector: c9 groups accepted+success; a3 missing groups non-accepted;
 *   accepted=1 successElig=1 success=1; rounds=[2] median=2; firstPass=1/1.
 */
const EXPECTED_B3: TaishiAcceptanceSuccessReworkSection = {
  kind: "taishi-acceptance-success-rework",
  legs: [
    {
      runId: LEG_A1_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:00:00.000Z",
      wallMs: 60_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_E5_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:02:00.000Z",
      wallMs: 100_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 2,
      rework: true,
    },
    {
      runId: LEG_F6_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:03:00.000Z",
      wallMs: 5_000,
      terminalLabel: "planned",
      accepted: true,
      success: false,
      successEligible: false,
      noReceipt: false,
      ordinalInLaneRole: 4,
      rework: true,
    },
    {
      runId: LEG_A7_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:04:00.000Z",
      wallMs: 20_000,
      terminalLabel: "no-receipt",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: true,
      ordinalInLaneRole: 5,
      rework: true,
    },
    {
      runId: LEG_C5_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:11:00.000Z",
      wallMs: 12_000,
      terminalLabel: "partially_completed",
      accepted: true,
      success: false,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 6,
      rework: true,
    },
    {
      runId: LEG_E6_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:02:00.000Z",
      wallMs: 10_000,
      terminalLabel: "refused",
      accepted: true,
      success: false,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 3,
      rework: true,
    },
    {
      runId: LEG_C9_RUN,
      book: BOOK,
      role: "collector",
      startedAt: "2026-08-01T00:06:00.000Z",
      wallMs: 6_000,
      terminalLabel: "groups",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_A3_RUN,
      book: BOOK,
      role: "collector",
      startedAt: "2026-08-01T00:09:30.000Z",
      wallMs: 3_000,
      terminalLabel: "non-accepted",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: false,
      ordinalInLaneRole: 2,
      rework: true,
    },
    {
      runId: LEG_D0_RUN,
      book: BOOK,
      role: "doctor",
      startedAt: "2026-08-01T00:07:00.000Z",
      wallMs: 3_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_F2_RUN,
      book: BOOK,
      role: "fixer",
      startedAt: "2026-08-01T00:09:00.000Z",
      wallMs: 9_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_B2_RUN,
      book: BOOK,
      role: "judge",
      startedAt: "2026-08-01T00:01:00.000Z",
      wallMs: 8_000,
      terminalLabel: "converged",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_D2_RUN,
      book: BOOK,
      role: "judge",
      startedAt: "2026-08-01T00:11:20.000Z",
      wallMs: 6_000,
      terminalLabel: "continue",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 2,
      rework: true,
    },
    {
      runId: LEG_E3_RUN,
      book: BOOK,
      role: "judge",
      startedAt: "2026-08-01T00:11:30.000Z",
      wallMs: 4_000,
      terminalLabel: "escalate",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 3,
      rework: true,
    },
    {
      runId: LEG_E1_RUN,
      book: BOOK,
      role: "merger",
      startedAt: "2026-08-01T00:08:00.000Z",
      wallMs: 7_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_B8_RUN,
      book: BOOK,
      role: "reviewer",
      startedAt: "2026-08-01T00:05:00.000Z",
      wallMs: 4_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_B1_RUN,
      book: BOOK_B,
      role: "coder",
      startedAt: "2026-08-01T00:10:00.000Z",
      wallMs: 15_000,
      terminalLabel: "completed",
      accepted: true,
      success: true,
      successEligible: true,
      noReceipt: false,
      ordinalInLaneRole: 1,
      rework: false,
    },
    {
      runId: LEG_F1_RUN,
      book: BOOK_C,
      role: "coder",
      startedAt: "2026-08-01T00:12:00.000Z",
      wallMs: 25_000,
      terminalLabel: "no-receipt",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: true,
      ordinalInLaneRole: 1,
      rework: false,
    },
  ],
  byRole: [
    {
      role: "coder",
      acceptedCount: 6,
      successEligibleCount: 5,
      successCount: 3,
      noReceiptCount: 2,
      successRate: 3 / 5,
      appearanceLaneCount: 3,
      firstPassLaneCount: 2,
      firstPassRate: 2 / 3,
      convergenceRounds: [6, 1, 1],
      convergenceRoundsMedian: 1,
    },
    {
      role: "collector",
      acceptedCount: 1,
      successEligibleCount: 1,
      successCount: 1,
      noReceiptCount: 0,
      successRate: 1,
      appearanceLaneCount: 1,
      firstPassLaneCount: 1,
      firstPassRate: 1,
      convergenceRounds: [2],
      convergenceRoundsMedian: 2,
    },
    {
      role: "doctor",
      acceptedCount: 1,
      successEligibleCount: 1,
      successCount: 1,
      noReceiptCount: 0,
      successRate: 1,
      appearanceLaneCount: 1,
      firstPassLaneCount: 1,
      firstPassRate: 1,
      convergenceRounds: [1],
      convergenceRoundsMedian: 1,
    },
    {
      role: "fixer",
      acceptedCount: 1,
      successEligibleCount: 1,
      successCount: 1,
      noReceiptCount: 0,
      successRate: 1,
      appearanceLaneCount: 1,
      firstPassLaneCount: 1,
      firstPassRate: 1,
      convergenceRounds: [1],
      convergenceRoundsMedian: 1,
    },
    {
      role: "judge",
      acceptedCount: 3,
      successEligibleCount: 3,
      successCount: 3,
      noReceiptCount: 0,
      successRate: 1,
      appearanceLaneCount: 1,
      firstPassLaneCount: 1,
      firstPassRate: 1,
      convergenceRounds: [3],
      convergenceRoundsMedian: 3,
    },
    {
      role: "merger",
      acceptedCount: 1,
      successEligibleCount: 1,
      successCount: 1,
      noReceiptCount: 0,
      successRate: 1,
      appearanceLaneCount: 1,
      firstPassLaneCount: 1,
      firstPassRate: 1,
      convergenceRounds: [1],
      convergenceRoundsMedian: 1,
    },
    {
      role: "reviewer",
      acceptedCount: 1,
      successEligibleCount: 1,
      successCount: 1,
      noReceiptCount: 0,
      successRate: 1,
      appearanceLaneCount: 1,
      firstPassLaneCount: 1,
      firstPassRate: 1,
      convergenceRounds: [1],
      convergenceRoundsMedian: 1,
    },
  ],
  rework: {
    reworkWallMs: 160_000,
    totalWallMs: 297_000,
    reworkRatio: 160_000 / 297_000,
    reworkLegCount: 8,
    totalLegCount: 17,
  },
};

function gitPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
}

async function withBusinessRepo<T>(fn: (repo: string, porcelainBefore: string) => Promise<T>): Promise<T> {
  const businessRepo = await mkdtemp(join(tmpdir(), "taishi-business-"));
  try {
    execFileSync("git", ["init"], { cwd: businessRepo });
    await writeFile(join(businessRepo, "README.md"), "business\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: businessRepo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: businessRepo },
    );
    const porcelainBefore = gitPorcelain(businessRepo);
    assert.equal(porcelainBefore, "", "business repo starts clean");
    const result = await fn(businessRepo, porcelainBefore);
    assert.equal(gitPorcelain(businessRepo), porcelainBefore, "business repo zero write");
    return result;
  } finally {
    await rm(businessRepo, { recursive: true, force: true });
  }
}

/**
 * Fixture injection stays below the production contract: hermetic process HOME
 * (os.homedir) — never a production invocation `home` field (ADR 0048).
 */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "taishi-home-"));
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

test("taishi issue-mode entry: fixture legs+unreadable hand-equal, porcelain frozen, page replace idempotent", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      const pagePath = taishiIssuePagePath(ledgerHome, ISSUE_PROJECT_ROOT);

      // Pre-seed a stale page at the canonical path — replace must be atomic/idempotent.
      await mkdir(join(ledgerHome, "taishi", "issues"), { recursive: true });
      await writeFile(
        pagePath,
        `${JSON.stringify({
          kind: "taishi-issue-metrics",
          mode: "issue",
          projectRoot: ISSUE_PROJECT_ROOT,
          legs: [],
          unreadable: [],
          unreadableCount: 0,
          stale: true,
        }, null, 2)}\n`,
        "utf8",
      );

      const first = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });

      assert.equal(first.mode, "issue");
      assert.equal(first.pagePath, pagePath);
      assert.equal(first.page.kind, "taishi-issue-metrics");
      assert.equal(first.page.mode, "issue");
      assert.equal(first.page.projectRoot, physicalPathIdentity(ISSUE_PROJECT_ROOT));
      assert.equal(
        "version" in (first.page as unknown as Record<string, unknown>),
        false,
        "page admits no readerless version field",
      );

      // Hand-computed leg list (other-issue run excluded; damaged excluded from legs).
      assert.deepEqual(first.page.legs, [...EXPECTED_LEGS]);
      // a2-seam-probe retired: B1 leg-wall-clock absorbs/replaces the A2 probe section.
      assert.equal(
        "a2SeamProbe" in (first.page as unknown as Record<string, unknown>),
        false,
        "retired a2-seam-probe must not appear on the issue page",
      );

      // B3: acceptance/success sets, rework lens, first-pass — hand oracle equality.
      // Section lands via family discovery spread (page skeleton not edited).
      const pageRecord = first.page as PageWithAcceptanceSuccessRework;
      assert.deepEqual(pageRecord.acceptanceSuccessRework, EXPECTED_B3);
      const b3 = pageRecord.acceptanceSuccessRework!;
      // Acceptance ≠ success: planned accepted but not success-eligible / not success.
      const planned = b3.legs.find((leg) => leg.runId === LEG_F6_RUN);
      assert.ok(planned);
      assert.equal(planned.accepted, true);
      assert.equal(planned.success, false);
      assert.equal(planned.successEligible, false);
      assert.equal(planned.terminalLabel, "planned");
      // coder partially_completed: accepted non-success (PRD worker apply vocabulary).
      const partial = b3.legs.find((leg) => leg.runId === LEG_C5_RUN);
      assert.ok(partial);
      assert.equal(partial.terminalLabel, "partially_completed");
      assert.equal(partial.accepted, true);
      assert.equal(partial.success, false);
      assert.equal(partial.successEligible, true);
      // B3 refused fixture (relocated e6): accepted non-success.
      const refused = b3.legs.find((leg) => leg.runId === LEG_E6_RUN);
      assert.ok(refused);
      assert.equal(refused.terminalLabel, "refused");
      assert.equal(refused.accepted, true);
      assert.equal(refused.success, false);
      assert.equal(refused.successEligible, true);
      assert.equal(refused.wallMs, 10_000);
      assert.equal(refused.ordinalInLaneRole, 3);
      assert.equal(refused.rework, true);
      // B2 overlap e5 remains completed success on the shared board.
      const overlap = b3.legs.find((leg) => leg.runId === LEG_E5_RUN);
      assert.ok(overlap);
      assert.equal(overlap.terminalLabel, "completed");
      assert.equal(overlap.accepted, true);
      assert.equal(overlap.success, true);
      assert.equal(overlap.wallMs, 100_000);
      assert.equal(overlap.ordinalInLaneRole, 2);
      assert.equal(overlap.rework, true);
      // judge continue/escalate: verdict production = duty complete = success.
      const judgeContinue = b3.legs.find((leg) => leg.runId === LEG_D2_RUN);
      const judgeEscalate = b3.legs.find((leg) => leg.runId === LEG_E3_RUN);
      const judgeConverged = b3.legs.find((leg) => leg.runId === LEG_B2_RUN);
      assert.ok(judgeContinue && judgeEscalate && judgeConverged);
      for (const leg of [judgeConverged, judgeContinue, judgeEscalate]) {
        assert.equal(leg.accepted, true);
        assert.equal(leg.success, true);
        assert.equal(leg.successEligible, true);
      }
      assert.equal(judgeContinue.terminalLabel, "continue");
      assert.equal(judgeEscalate.terminalLabel, "escalate");
      // No-receipt 5th call (a7): not success den; wall fully booked as rework.
      const noReceipt = b3.legs.find((leg) => leg.runId === LEG_A7_RUN);
      assert.ok(noReceipt);
      assert.equal(noReceipt.noReceipt, true);
      assert.equal(noReceipt.accepted, false);
      assert.equal(noReceipt.successEligible, false);
      // First-call no-receipt lane (f1/book-c): appearance den only, not first-pass num,
      // not success den; wall fully booked (ordinal 1 → not rework).
      const firstNoReceipt = b3.legs.find((leg) => leg.runId === LEG_F1_RUN);
      assert.ok(firstNoReceipt);
      assert.equal(firstNoReceipt.book, BOOK_C);
      assert.equal(firstNoReceipt.noReceipt, true);
      assert.equal(firstNoReceipt.accepted, false);
      assert.equal(firstNoReceipt.successEligible, false);
      assert.equal(firstNoReceipt.ordinalInLaneRole, 1);
      assert.equal(firstNoReceipt.rework, false);
      assert.equal(firstNoReceipt.wallMs, 25_000);
      const coderStats = b3.byRole.find((row) => row.role === "coder");
      assert.ok(coderStats);
      assert.equal(coderStats.noReceiptCount, 2);
      assert.equal(coderStats.appearanceLaneCount, 3);
      assert.equal(coderStats.firstPassLaneCount, 2);
      assert.equal(coderStats.firstPassRate, 2 / 3);
      assert.equal(coderStats.successEligibleCount, 5);
      assert.equal(coderStats.successCount, 3);
      assert.equal(coderStats.successRate, 3 / 5);
      assert.deepEqual(coderStats.convergenceRounds, [6, 1, 1]);
      const judgeStats = b3.byRole.find((row) => row.role === "judge");
      assert.ok(judgeStats);
      assert.equal(judgeStats.acceptedCount, 3);
      assert.equal(judgeStats.successCount, 3);
      assert.equal(judgeStats.successRate, 1);
      assert.deepEqual(judgeStats.convergenceRounds, [3]);
      // Collector groups empty array accepted; missing groups non-accepted.
      const groupsLeg = b3.legs.find((leg) => leg.runId === LEG_C9_RUN);
      const missingGroups = b3.legs.find((leg) => leg.runId === LEG_A3_RUN);
      assert.ok(groupsLeg && missingGroups);
      assert.equal(groupsLeg.terminalLabel, "groups");
      assert.equal(groupsLeg.accepted, true);
      assert.equal(missingGroups.terminalLabel, "non-accepted");
      assert.equal(missingGroups.accepted, false);
      // Rework: 2nd+ same lane+role; weighted wall ratio hand-equal (B2+B3 board).
      assert.equal(b3.rework.reworkWallMs, 160_000);
      assert.equal(b3.rework.totalWallMs, 297_000);
      assert.equal(b3.rework.reworkRatio, 160_000 / 297_000);
      assert.equal(b3.rework.reworkLegCount, 8);
      // Convergence rounds median uses shared odd-sample middle primitive.
      assert.equal(coderStats.convergenceRoundsMedian, medianNumber([6, 1, 1]));

      // Damaged run: loud unreadable exclusion + single count; duration not on page.
      assert.equal(first.page.unreadableCount, 1);
      assert.equal(first.page.unreadable.length, 1);
      const damaged = first.page.unreadable[0]!;
      assert.equal(damaged.runId, EXPECTED_UNREADABLE[0]!.runId);
      assert.equal(damaged.book, EXPECTED_UNREADABLE[0]!.book);
      assert.deepEqual(damaged.missingSources, [...EXPECTED_UNREADABLE[0]!.missingSources]);
      assert.match(damaged.reason, /malformed JSONL record/i);
      // No wall-clock / duration field admitted for unreadable runs on A1 page.
      assert.equal(
        "wallMs" in damaged || "durationMs" in damaged || "elapsedMs" in damaged,
        false,
      );

      const onDisk = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.deepEqual(onDisk, first.page);
      assert.equal("stale" in (onDisk as unknown as Record<string, unknown>), false);
      assert.equal("version" in (onDisk as unknown as Record<string, unknown>), false);

      // Atomic replace idempotent: second run yields equivalent page bytes/content.
      const firstBytes = await readFile(pagePath, "utf8");
      const second = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });
      assert.deepEqual(second.page, first.page);
      assert.equal(await readFile(pagePath, "utf8"), firstBytes);
      const onDiskAgain = JSON.parse(await readFile(pagePath, "utf8")) as TaishiIssueMetricsPage;
      assert.deepEqual(onDiskAgain, first.page);
    });
  });
});

test("taishi issue-mode entry: null terminal artifact is terminal-artifact unreadable and excluded from legs", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async (home) => {
      const reportPath = join(
        home,
        ".ak-roles",
        "books",
        BOOK,
        "runs",
        LEG_A1_DIR,
        "artifacts",
        "report.json",
      );
      await writeFile(reportPath, "null\n", "utf8");

      const result = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });

      assert.equal(
        result.page.legs.some((leg) => leg.runId === LEG_A1_RUN),
        false,
        "run with null terminal artifact must leave legs",
      );
      const entry = result.page.unreadable.find((u) => u.runId === LEG_A1_RUN);
      assert.ok(entry, "null terminal artifact must produce unreadable entry");
      assert.deepEqual(entry.missingSources, ["terminal-artifact"]);
      assert.match(entry.reason, /null/i);
      // Fixture session-damaged run remains; plus this terminal-artifact failure.
      assert.equal(result.page.unreadableCount, 2);
      assert.equal(result.page.unreadable.length, 2);
      assert.equal(
        result.page.legs.some((leg) => leg.runId === LEG_A1_RUN),
        false,
      );
      // Other readable fixture legs remain (B2/B3 expansion); only a1 leaves legs.
      assert.ok(result.page.legs.length >= 1);
      assert.ok(
        result.page.legs.some((leg) => leg.runId === LEG_E5_RUN),
        "B2 overlap e5 must remain when only coder a1 terminal is null",
      );
      assert.ok(
        result.page.legs.some((leg) => leg.runId === LEG_B2_RUN),
        "judge leg must remain when only coder a1 terminal is null",
      );
      assert.ok(
        result.page.legs.some((leg) => leg.runId === LEG_E6_RUN),
        "B3 refused e6 must remain when only coder a1 terminal is null",
      );
    });
  });
});

test("taishi shared median primitive: even-sample mean of two middles (fixture wall spans)", () => {
  // Fixture readable walls: a1=60000, b2=8000 → (8000+60000)/2 = 34000.
  // Shared primitive remains the sole even-sample convention owner.
  assert.equal(medianNumber([60_000, 8_000]), 34_000);
  assert.equal(medianNumber([8_000, 60_000]), 34_000);
  assert.equal(medianNumber([3]), 3);
  assert.equal(medianNumber([1, 2, 3]), 2);
  assert.equal(medianNumber([]), undefined);
});

test("taishi B1 leg-wall-clock family: fixture ranking/median/total hand-equal; damaged excluded", async () => {
  await withBusinessRepo(async () => {
    await withTempHome(async () => {
      const result = await runTaishi({
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
      });
      const page = result.page as PageWithLegWallClock;

      // Ticket-pinned acceptance on the merged B1+B2+B3 board.
      assert.deepEqual(page.legWallClock, EXPECTED_LEG_WALL_CLOCK);
      assert.equal(page.legWallClock?.medianWallMs, 8_000);
      assert.equal(page.legWallClock?.totalElapsedMs, 297_000);
      assert.deepEqual(
        page.legWallClock?.ranking.map((leg) => leg.wallMs),
        [
          100_000, 60_000, 25_000, 20_000, 15_000, 12_000, 10_000, 9_000, 8_000, 7_000,
          6_000, 6_000, 5_000, 4_000, 4_000, 3_000, 3_000,
        ],
      );

      // Damaged run stays unreadable; board covers exactly the readable leg set.
      assert.equal(page.unreadableCount, 1);
      assert.equal(page.unreadable[0]!.runId, EXPECTED_UNREADABLE[0]!.runId);
      assert.equal(page.legWallClock?.ranking.length, EXPECTED_LEGS.length);
      assert.equal(page.legWallClock?.ranking.length, page.legs.length);
      assert.deepEqual(
        new Set(page.legWallClock?.ranking.map((leg) => leg.runId)),
        new Set(page.legs.map((leg) => leg.runId)),
      );

      // Family module is discovery-registered (drop-in file only).
      const families = await loadTaishiIssueMetricFamilies();
      assert.ok(
        families.some((family) => family.id === "leg-wall-clock"),
        "leg-wall-clock family must register via production discovery",
      );
    });
  });
});

test("taishi metric-family production discovery: real family files register without shared-list edits", async () => {
  // Registration proof stays on the production path — real family modules under
  // taishi-metric-families/ are discovered by the real loader (no test-only dir hook).
  // Inclusion only: B1 absorbed/replaced a2-seam-probe; pin the live product families,
  // not the retired probe inventory. B2/B3 drop-ins land alongside.
  const names = (await readdir(TAISHI_ISSUE_METRIC_FAMILIES_DIR))
    .filter((name) => {
      if (name.endsWith(".d.ts")) return false;
      if (name.includes(".test.")) return false;
      return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
    })
    .sort((a, b) => a.localeCompare(b));
  assert.equal(
    names.includes("a2-seam-probe.ts"),
    false,
    "retired a2-seam-probe family module must not remain under production discovery",
  );
  assert.ok(
    names.includes("leg-wall-clock.ts"),
    "B1 leg-wall-clock family module must register under production discovery",
  );
  assert.ok(
    names.includes("b2-frame-buckets-actions.ts"),
    "B2 frame-buckets-actions family module must register under production discovery",
  );
  assert.ok(
    names.includes("acceptance-success-rework.ts"),
    "B3 acceptance-success-rework family must register by file drop-in",
  );

  const families = await loadTaishiIssueMetricFamilies();
  assert.equal(
    families.some((family) => family.id === "a2-seam-probe"),
    false,
    "loaded families must not include retired a2-seam-probe",
  );
  assert.ok(
    families.some((family) => family.id === "leg-wall-clock"),
    "loaded families must include leg-wall-clock",
  );
  assert.ok(
    families.some((family) => family.id === "b2-frame-buckets-actions"),
    "loaded families must include b2-frame-buckets-actions",
  );
  assert.ok(
    families.some((family) => family.id === "acceptance-success-rework"),
    "loaded families must include acceptance-success-rework",
  );
  // Production registry is the same discovery product (loaded once at import).
  assert.equal(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "a2-seam-probe"),
    false,
    "production registry must not include retired a2-seam-probe",
  );
  assert.ok(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "leg-wall-clock"),
    "production registry must include leg-wall-clock",
  );
  assert.ok(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "b2-frame-buckets-actions"),
    "production registry must include b2-frame-buckets-actions",
  );
  assert.ok(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "acceptance-success-rework"),
    "production registry must include acceptance-success-rework",
  );
});

test("taishi issue-mode entry: taishi path symlink into consumer repo is refused without porcelain change", async () => {
  await withBusinessRepo(async (businessRepo) => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await symlink(businessRepo, join(ledgerHome, "taishi"));

      await assert.rejects(
        () =>
          runTaishi({
            mode: "issue",
            projectRoot: ISSUE_PROJECT_ROOT,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ActivationLedgerError);
          assert.match(error.message, /symbolic link/i);
          return true;
        },
      );

      // No issues page may land in the consumer tree via the symlink.
      const escaped = await readFile(
        join(businessRepo, "issues", `${"x"}.json`),
        "utf8",
      ).then(
        () => true,
        () => false,
      );
      assert.equal(escaped, false);
      // Directory listing of business repo stays commit-only.
      const listing = execFileSync("ls", ["-la"], {
        cwd: businessRepo,
        encoding: "utf8",
      });
      assert.equal(listing.includes("issues"), false);
    });
  });
});
