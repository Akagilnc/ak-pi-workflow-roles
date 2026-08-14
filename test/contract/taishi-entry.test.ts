/**
 * #324 taishi-A1 — sole entry seam tracer.
 * Fixture ledger (2 readable legs + 1 damaged session run + 1 other-issue run)
 * → issue-mode typed page with hand-computed legs/unreadable equality,
 * business-repo porcelain unchanged, atomic page replace idempotent.
 * Variants: null terminal artifact → unreadable; taishi symlink into consumer → refuse.
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
import {
  taishiIssuePagePath,
  type TaishiIssueMetricsPage,
} from "../../src/taishi-page.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureHome = join(packageRoot, "test/fixtures/taishi/home");

const ISSUE_PROJECT_ROOT = "/taishi-fixture/issue-demo";
const BOOK = "fixture-book";
const BOOK_B = "fixture-book-b";
const LEG_A1_RUN = "019ff000-0001-7000-8000-0000000000a1";
const LEG_A1_DIR = `${LEG_A1_RUN}@coder`;
const LEG_B2_RUN = "019ff000-0002-7000-8000-0000000000b2";
const LEG_E5_RUN = "019ff000-0005-7000-8000-0000000000e5";
const LEG_F6_RUN = "019ff000-0006-7000-8000-0000000000f6";
const LEG_A7_RUN = "019ff000-0007-7000-8000-0000000000a7";
const LEG_B8_RUN = "019ff000-0008-7000-8000-0000000000b8";
const LEG_C9_RUN = "019ff000-0009-7000-8000-0000000000c9";
const LEG_D0_RUN = "019ff000-000a-7000-8000-0000000000d0";
const LEG_E1_RUN = "019ff000-000b-7000-8000-0000000000e1";
const LEG_F2_RUN = "019ff000-000c-7000-8000-0000000000f2";
const LEG_A3_RUN = "019ff000-000d-7000-8000-0000000000a3";
const LEG_B1_RUN = "019ff000-0010-7000-8000-0000000000b1";

/** Hand-computed from fixture (scope = ISSUE_PROJECT_ROOT); sort = book, role, runId. */
const EXPECTED_LEGS = [
  { runId: LEG_A1_RUN, book: BOOK, role: "coder" },
  { runId: LEG_E5_RUN, book: BOOK, role: "coder" },
  { runId: LEG_F6_RUN, book: BOOK, role: "coder" },
  { runId: LEG_A7_RUN, book: BOOK, role: "coder" },
  { runId: LEG_C9_RUN, book: BOOK, role: "collector" },
  { runId: LEG_A3_RUN, book: BOOK, role: "collector" },
  { runId: LEG_D0_RUN, book: BOOK, role: "doctor" },
  { runId: LEG_F2_RUN, book: BOOK, role: "fixer" },
  { runId: LEG_B2_RUN, book: BOOK, role: "judge" },
  { runId: LEG_E1_RUN, book: BOOK, role: "merger" },
  { runId: LEG_B8_RUN, book: BOOK, role: "reviewer" },
  { runId: LEG_B1_RUN, book: BOOK_B, role: "coder" },
] as const;

const EXPECTED_UNREADABLE = [
  {
    runId: "019ff000-0003-7000-8000-0000000000c3",
    book: BOOK,
    missingSources: ["session-timeline"] as const,
  },
] as const;

function emptyToolsProbe(
  runId: string,
  book: string,
  role: string,
  startedAt: string,
  endedAt: string,
  terminal: { status: "absent" } | { status: "present"; file: "report.json"; role: string },
) {
  return {
    runId,
    book,
    role,
    frameSpan: { startedAt, endedAt },
    toolIntervals: [] as const,
    terminal,
  };
}

/**
 * A2 seam-probe hand values from fixture sessions (readable legs only).
 * Raw frame span / tool intervals / terminal face only — no derived metrics.
 * Sort = book, role, runId (family projection order).
 */
const EXPECTED_A2_SEAM_PROBE = {
  kind: "taishi-a2-seam-probe",
  runs: [
    {
      runId: LEG_A1_RUN,
      book: BOOK,
      role: "coder",
      frameSpan: {
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T00:01:00.000Z",
      },
      toolIntervals: [
        {
          toolCallId: "call_bash_a",
          toolName: "bash",
          startedAt: "2026-08-01T00:00:10.000Z",
          endedAt: "2026-08-01T00:00:40.000Z",
        },
        {
          toolCallId: "call_out_a",
          toolName: "ak_coder_output",
          startedAt: "2026-08-01T00:00:55.000Z",
          endedAt: "2026-08-01T00:01:00.000Z",
        },
      ],
      terminal: { status: "present", file: "report.json", role: "coder" },
    },
    emptyToolsProbe(
      LEG_E5_RUN,
      BOOK,
      "coder",
      "2026-08-01T00:02:00.000Z",
      "2026-08-01T00:02:10.000Z",
      { status: "present", file: "report.json", role: "coder" },
    ),
    emptyToolsProbe(
      LEG_F6_RUN,
      BOOK,
      "coder",
      "2026-08-01T00:03:00.000Z",
      "2026-08-01T00:03:05.000Z",
      { status: "present", file: "report.json", role: "coder" },
    ),
    emptyToolsProbe(
      LEG_A7_RUN,
      BOOK,
      "coder",
      "2026-08-01T00:04:00.000Z",
      "2026-08-01T00:04:20.000Z",
      { status: "absent" },
    ),
    emptyToolsProbe(
      LEG_C9_RUN,
      BOOK,
      "collector",
      "2026-08-01T00:06:00.000Z",
      "2026-08-01T00:06:06.000Z",
      { status: "present", file: "report.json", role: "collector" },
    ),
    emptyToolsProbe(
      LEG_A3_RUN,
      BOOK,
      "collector",
      "2026-08-01T00:09:30.000Z",
      "2026-08-01T00:09:33.000Z",
      { status: "present", file: "report.json", role: "collector" },
    ),
    emptyToolsProbe(
      LEG_D0_RUN,
      BOOK,
      "doctor",
      "2026-08-01T00:07:00.000Z",
      "2026-08-01T00:07:03.000Z",
      { status: "present", file: "report.json", role: "doctor" },
    ),
    emptyToolsProbe(
      LEG_F2_RUN,
      BOOK,
      "fixer",
      "2026-08-01T00:09:00.000Z",
      "2026-08-01T00:09:09.000Z",
      { status: "present", file: "report.json", role: "fixer" },
    ),
    {
      runId: LEG_B2_RUN,
      book: BOOK,
      role: "judge",
      frameSpan: {
        startedAt: "2026-08-01T00:01:00.000Z",
        endedAt: "2026-08-01T00:01:08.000Z",
      },
      toolIntervals: [
        {
          toolCallId: "call_judge_b",
          toolName: "ak_judge_output",
          startedAt: "2026-08-01T00:01:05.000Z",
          endedAt: "2026-08-01T00:01:08.000Z",
        },
      ],
      terminal: { status: "present", file: "report.json", role: "judge" },
    },
    emptyToolsProbe(
      LEG_E1_RUN,
      BOOK,
      "merger",
      "2026-08-01T00:08:00.000Z",
      "2026-08-01T00:08:07.000Z",
      { status: "present", file: "report.json", role: "merger" },
    ),
    emptyToolsProbe(
      LEG_B8_RUN,
      BOOK,
      "reviewer",
      "2026-08-01T00:05:00.000Z",
      "2026-08-01T00:05:04.000Z",
      { status: "present", file: "report.json", role: "reviewer" },
    ),
    emptyToolsProbe(
      LEG_B1_RUN,
      BOOK_B,
      "coder",
      "2026-08-01T00:10:00.000Z",
      "2026-08-01T00:10:15.000Z",
      { status: "present", file: "report.json", role: "coder" },
    ),
  ],
} as const;

/**
 * B3 hand oracle (ticket #327 + PRD #298 票面补正).
 *
 * Walls (ms): a1=60000, e5=10000, f6=5000, a7=20000, b2=8000, b8=4000,
 * c9=6000, d0=3000, e1=7000, f2=9000, a3=3000, b1=15000.
 * totalWall=150000; rework={e5,f6,a7,a3}=10000+5000+20000+3000=38000; ratio=38000/150000.
 *
 * coder: accepted={a1,e5,f6,b1}=4; successEligible={a1,e5,b1}=3 (planned f6 out);
 *   success={a1,b1}=2; rate=2/3; noReceipt={a7}=1;
 *   lanes={fixture-book,fixture-book-b}=2; first both accepted → firstPass=2/2=1;
 *   rounds=[4,1] (book order fixture-book then fixture-book-b... wait books sorted:
 *   fixture-book first → rounds for fixture-book=4, fixture-book-b=1 → [4,1]; median=2.5.
 * collector: c9 groups accepted+success; a3 missing groups non-accepted;
 *   accepted=1 successElig=1 success=1; rounds=[2] median=2; firstPass=1/1 (c9 first).
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
      wallMs: 10_000,
      terminalLabel: "refused",
      accepted: true,
      success: false,
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
      ordinalInLaneRole: 3,
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
      ordinalInLaneRole: 4,
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
  ],
  byRole: [
    {
      role: "coder",
      acceptedCount: 4,
      successEligibleCount: 3,
      successCount: 2,
      noReceiptCount: 1,
      successRate: 2 / 3,
      appearanceLaneCount: 2,
      firstPassLaneCount: 2,
      firstPassRate: 1,
      convergenceRounds: [4, 1],
      convergenceRoundsMedian: 2.5,
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
    reworkWallMs: 38_000,
    totalWallMs: 150_000,
    reworkRatio: 38_000 / 150_000,
    reworkLegCount: 4,
    totalLegCount: 12,
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

      // A2: example family consumes typed per-run facts (span/tools/terminal) only.
      assert.deepEqual(first.page.a2SeamProbe, EXPECTED_A2_SEAM_PROBE);
      // 零新指标: no per-run derived duration or aggregate median on the page.
      const probe = first.page.a2SeamProbe!;
      assert.equal(
        "frameSpanMedianMs" in (probe as unknown as Record<string, unknown>),
        false,
      );
      for (const run of probe.runs) {
        assert.equal(
          "frameSpanMs" in (run as unknown as Record<string, unknown>),
          false,
        );
      }

      // B3: acceptance/success sets, rework lens, first-pass — hand oracle equality.
      // Section lands via family discovery spread (page skeleton not edited).
      const pageRecord = first.page as TaishiIssueMetricsPage & {
        readonly acceptanceSuccessRework?: TaishiAcceptanceSuccessReworkSection;
      };
      assert.deepEqual(pageRecord.acceptanceSuccessRework, EXPECTED_B3);
      const b3 = pageRecord.acceptanceSuccessRework!;
      // Acceptance ≠ success: planned accepted but not success-eligible / not success.
      const planned = b3.legs.find((leg) => leg.runId === LEG_F6_RUN);
      assert.ok(planned);
      assert.equal(planned.accepted, true);
      assert.equal(planned.success, false);
      assert.equal(planned.successEligible, false);
      assert.equal(planned.terminalLabel, "planned");
      // No-receipt: in first-pass appearance den via lane presence; not success den.
      const noReceipt = b3.legs.find((leg) => leg.runId === LEG_A7_RUN);
      assert.ok(noReceipt);
      assert.equal(noReceipt.noReceipt, true);
      assert.equal(noReceipt.accepted, false);
      assert.equal(noReceipt.successEligible, false);
      const coderStats = b3.byRole.find((row) => row.role === "coder");
      assert.ok(coderStats);
      assert.equal(coderStats.noReceiptCount, 1);
      assert.equal(coderStats.appearanceLaneCount, 2);
      assert.equal(coderStats.successEligibleCount, 3);
      assert.equal(coderStats.successCount, 2);
      assert.equal(coderStats.successRate, 2 / 3);
      // Collector groups empty array accepted; missing groups non-accepted.
      const groupsLeg = b3.legs.find((leg) => leg.runId === LEG_C9_RUN);
      const missingGroups = b3.legs.find((leg) => leg.runId === LEG_A3_RUN);
      assert.ok(groupsLeg && missingGroups);
      assert.equal(groupsLeg.terminalLabel, "groups");
      assert.equal(groupsLeg.accepted, true);
      assert.equal(missingGroups.terminalLabel, "non-accepted");
      assert.equal(missingGroups.accepted, false);
      // Rework: 2nd+ same lane+role; weighted wall ratio hand-equal.
      assert.equal(b3.rework.reworkWallMs, 38_000);
      assert.equal(b3.rework.totalWallMs, 150_000);
      assert.equal(b3.rework.reworkRatio, 38_000 / 150_000);
      assert.equal(b3.rework.reworkLegCount, 4);
      // Convergence rounds median uses shared even-sample mean primitive.
      assert.equal(coderStats.convergenceRoundsMedian, medianNumber([4, 1]));

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
      // Other readable fixture legs remain (B3 expansion); only a1 leaves legs.
      assert.ok(result.page.legs.length >= 1);
      assert.ok(
        result.page.legs.some((leg) => leg.runId === LEG_B2_RUN),
        "judge leg must remain when only coder a1 terminal is null",
      );
    });
  });
});

test("taishi shared median primitive: even-sample mean of two middles (fixture wall spans)", () => {
  // Fixture readable walls: a1=60000, b2=8000 → (8000+60000)/2 = 34000.
  // Proved on the shared primitive only — not persisted on the issue page.
  assert.equal(medianNumber([60_000, 8_000]), 34_000);
  assert.equal(medianNumber([8_000, 60_000]), 34_000);
  assert.equal(medianNumber([3]), 3);
  assert.equal(medianNumber([1, 2, 3]), 2);
  assert.equal(medianNumber([]), undefined);
});

test("taishi metric-family production discovery: real family files register without shared-list edits", async () => {
  // Registration proof stays on the production path — real family modules under
  // taishi-metric-families/ are discovered by the real loader (no test-only dir hook).
  // Inclusion only: B-wave family files may land alongside the A2 probe without
  // forcing this shared tracer to re-pin the full registry inventory.
  const names = (await readdir(TAISHI_ISSUE_METRIC_FAMILIES_DIR))
    .filter((name) => {
      if (name.endsWith(".d.ts")) return false;
      if (name.includes(".test.")) return false;
      return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
    })
    .sort((a, b) => a.localeCompare(b));
  assert.ok(
    names.includes("a2-seam-probe.ts"),
    "A2 seam-probe family module must remain registered under production discovery",
  );
  assert.ok(
    names.includes("acceptance-success-rework.ts"),
    "B3 acceptance-success-rework family must register by file drop-in",
  );

  const families = await loadTaishiIssueMetricFamilies();
  assert.ok(
    families.some((family) => family.id === "a2-seam-probe"),
    "loaded families must include a2-seam-probe",
  );
  assert.ok(
    families.some((family) => family.id === "acceptance-success-rework"),
    "loaded families must include acceptance-success-rework",
  );
  // Production registry is the same discovery product (loaded once at import).
  assert.ok(
    TAISHI_ISSUE_METRIC_FAMILIES.some((family) => family.id === "a2-seam-probe"),
    "production registry must include a2-seam-probe",
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
