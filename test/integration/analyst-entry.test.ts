/**
 * #324 analyst-A1 — sole entry seam tracer.
 * Fixture ledger (readable legs across B1/B2/B3/B4 fixtures + damaged session runs
 * + 1 other-issue run) → issue-mode typed page with hand-computed legs/unreadable
 * equality, business-repo porcelain unchanged, atomic page replace idempotent.
 * Variants: null terminal artifact → unreadable; analyst symlink into consumer → refuse.
 *
 * Merge note (#326+#327+#328): B2 keeps runId …0005/e5 as the overlap fixture; B3's
 * refused coder fixture is relocated to unique runId …0013/e6; B4 death no-receipt
 * and absent-first-frame unreadable relocate to …0014/e7 and …0015/f7 so both
 * prior board cases and B4 timeline branches remain.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ActivationLedgerError,
  physicalPathIdentity,
} from "../../src/activation-ledger-topology.ts";
import { runAnalyst } from "../../src/analyst-entry.ts";
import type { AnalystAcceptanceSuccessReworkSection } from "../../src/analyst-metric-families/acceptance-success-rework.ts";
import type { AnalystB2FrameBucketsActionsSection } from "../../src/analyst-metric-families/b2-frame-buckets-actions.ts";
import type { AnalystLegWallClockSection } from "../../src/analyst-metric-families/leg-wall-clock.ts";
import type {
  AnalystRoundTimelineRow,
  AnalystRoundTimelineSection,
} from "../../src/analyst-metric-families/round-timeline.ts";
import {
  analystIssuePagePath,
  type AnalystIssueMetricsPage,
} from "../../src/analyst-page.ts";
import {
  ANALYST_FIXTURE_BOOK as BOOK,
  ANALYST_ISSUE_DEMO as ISSUE_PROJECT_ROOT,
  ANALYST_LEG_A1_RUN as LEG_A1_RUN,
  ANALYST_LEG_B2_RUN as LEG_B2_RUN,
  ANALYST_LEG_E5_RUN as LEG_E5_RUN,
  withBusinessRepo,
  withTempHome,
} from "../helpers/analyst-fixture-kit.ts";
import { clearCurrentSection, seedCurrentSection, seedTerminal } from "../helpers/run-dossier-fixture.ts";

/** Family sections are discovery-contributed — not on the A1 page envelope type. */
type PageWithMetricFamilies = AnalystIssueMetricsPage & {
  readonly legWallClock?: AnalystLegWallClockSection;
  readonly b2FrameBucketsActions?: AnalystB2FrameBucketsActionsSection;
  readonly acceptanceSuccessRework?: AnalystAcceptanceSuccessReworkSection;
  readonly roundTimeline?: AnalystRoundTimelineSection;
};

const BOOK_B = "fixture-book-b";
const BOOK_C = "fixture-book-c";
const LEG_A1_DIR = `${LEG_A1_RUN}@coder`;
/** B2 overlap fixture (completed, wall 100_000) — retains historical e5 runId. */
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
/**
 * B4 death no-receipt fixture — relocated from colliding e5 runId during #328 merge
 * so B2 overlap completed/100s and B4 death/5s both remain on the board.
 */
const LEG_E7_RUN = "019ff000-0014-7000-8000-0000000000e7";
/** Damaged session with present first-frame prefix (c3 @ 00:00:30). */
const LEG_C3_RUN = "019ff000-0003-7000-8000-0000000000c3";
/**
 * B4 absent-first-frame unreadable — relocated from colliding f6 runId during #328 merge
 * so B3 planned readable f6 and B4 unreadable-absent both remain.
 */
const LEG_F7_RUN = "019ff000-0015-7000-8000-0000000000f7";

/** Hand-computed from fixture (scope = ISSUE_PROJECT_ROOT); sort = book, role, runId. */
const EXPECTED_LEGS = [
  { runId: LEG_A1_RUN, book: BOOK, role: "coder" },
  { runId: LEG_E5_RUN, book: BOOK, role: "coder" },
  { runId: LEG_F6_RUN, book: BOOK, role: "coder" },
  { runId: LEG_A7_RUN, book: BOOK, role: "coder" },
  { runId: LEG_C5_RUN, book: BOOK, role: "coder" },
  { runId: LEG_E6_RUN, book: BOOK, role: "coder" },
  { runId: LEG_E7_RUN, book: BOOK, role: "coder" },
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
    runId: LEG_C3_RUN,
    book: BOOK,
    missingSources: ["session-timeline"] as const,
    // Prefix frame before completed-malformed line — A2 must retain it.
    firstFrameAt: {
      status: "present" as const,
      at: "2026-08-01T00:00:30.000Z",
    },
  },
  {
    runId: LEG_F7_RUN,
    book: BOOK,
    missingSources: ["session-timeline"] as const,
    // First line already completed-malformed — no usable first frame.
    firstFrameAt: { status: "absent" as const },
  },
] as const;

/**
 * B1 leg-wall-clock hand values from fixture readable legs only (B1+B2+B3+B4 board).
 * Walls (ms): e5=100000, a1=60000, f1=25000, a7=20000, b1=15000, c5=12000,
 * e6=10000, f2=9000, b2=8000, e1=7000, c9=6000, d2=6000, f6=5000, e7=5000,
 * e3=4000, b8=4000, a3=3000, d0=3000.
 * Ranking wall-clock desc (ties: book, role, runId); median even-sample
 * mean-of-two-middles=(8000+7000)/2=7500; total = Σ walls = 302000.
 * Damaged/out-of-scope runs never enter (A1 contract).
 */
const EXPECTED_LEG_WALL_CLOCK = {
  kind: "analyst-leg-wall-clock",
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
    { runId: LEG_E7_RUN, book: BOOK, role: "coder", wallMs: 5_000 },
    { runId: LEG_E3_RUN, book: BOOK, role: "judge", wallMs: 4_000 },
    { runId: LEG_B8_RUN, book: BOOK, role: "reviewer", wallMs: 4_000 },
    { runId: LEG_A3_RUN, book: BOOK, role: "collector", wallMs: 3_000 },
    { runId: LEG_D0_RUN, book: BOOK, role: "doctor", wallMs: 3_000 },
  ],
  medianWallMs: 7_500,
  totalElapsedMs: 302_000,
} as const;

/**
 * B3 hand oracle (ticket #327 + PRD #298 r8 票面补正 + 施工审 r3),
 * recomputed after #326+#327+#328 merge kept B2 e5 overlap (completed/100s),
 * relocated B3 refused fixture to e6 (refused/10s), and relocated B4 death
 * no-receipt to e7 (no-receipt/5s @ 00:01:30).
 *
 * Walls (ms): a1=60000, e7=5000, e5=100000, e6=10000, f6=5000, a7=20000,
 * c5=12000, b2=8000, d2=6000, e3=4000, b8=4000, c9=6000, d0=3000, e1=7000,
 * f2=9000, a3=3000, b1=15000, f1=25000.
 * totalWall=302000;
 * rework={e7,e5,e6,f6,a7,c5,a3,d2,e3}=5000+100000+10000+5000+20000+12000+3000+6000+4000=165000;
 * ratio=165000/302000.
 *
 * coder: accepted={a1,e5,e6,f6,c5,b1}=6; successEligible={a1,e5,e6,c5,b1}=5
 *   (planned f6 out; no-receipt e7+a7+f1 out); success={a1,e5,b1}=3; rate=3/5;
 *   noReceipt={e7,a7,f1}=3;
 *   lanes={fixture-book,fixture-book-b,fixture-book-c}=3;
 *   first accepted on book+book-b only → firstPass=2/3;
 *   rounds books-sorted=[7,1,1]; median=1.
 * judge: b2 converged + d2 continue + e3 escalate — all accepted+success;
 *   rounds=[3] median=3; firstPass=1/1.
 * collector: c9 groups accepted+success; a3 missing groups non-accepted;
 *   accepted=1 successElig=1 success=1; rounds=[2] median=2; firstPass=1/1.
 */
const EXPECTED_B3: AnalystAcceptanceSuccessReworkSection = {
  kind: "analyst-acceptance-success-rework",
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
      ordinalInLaneRole: 3,
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
      ordinalInLaneRole: 5,
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
      ordinalInLaneRole: 6,
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
      ordinalInLaneRole: 7,
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
      ordinalInLaneRole: 4,
      rework: true,
    },
    {
      runId: LEG_E7_RUN,
      book: BOOK,
      role: "coder",
      startedAt: "2026-08-01T00:01:30.000Z",
      wallMs: 5_000,
      terminalLabel: "no-receipt",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: true,
      ordinalInLaneRole: 2,
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
      noReceiptCount: 3,
      successRate: 3 / 5,
      appearanceLaneCount: 3,
      firstPassLaneCount: 2,
      firstPassRate: 2 / 3,
      convergenceRounds: [7, 1, 1],
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
    reworkWallMs: 165_000,
    totalWallMs: 302_000,
    reworkRatio: 165_000 / 302_000,
    reworkLegCount: 9,
    totalLegCount: 18,
  },
};

/**
 * B4 round-timeline hand values (#328), recomputed on the union board.
 * Lanes = books sorted; fixture-book rows sorted by startedAt / present
 * firstFrameAt asc; unreadable without first-frame → tail + absent annotation.
 * a1 wall=60_000 receipt completed @ 00:00:00;
 * c3 unreadable firstFrameAt present @ 00:00:30 (mid-lane insertion);
 * b2 wall=8_000 receipt converged classCount=2 @ 00:01:00;
 * e7 wall=5_000 death no-receipt @ 00:01:30 (B4 case, relocated from e5);
 * e5 wall=100_000 receipt completed @ 00:02:00 (B2 overlap);
 * e6 wall=10_000 receipt refused @ 00:02:00;
 * f6 wall=5_000 receipt planned @ 00:03:00;
 * … remaining fixture-book legs by startedAt …
 * f7 unreadable firstFrameAt absent → lane tail (B4 case, relocated from f6).
 */
const EXPECTED_ROUND_TIMELINE_BOOK_ROWS = [
  {
    kind: "run" as const,
    runId: LEG_A1_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    wallMs: 60_000,
    terminal: { kind: "receipt" as const, status: "completed" },
  },
  {
    kind: "unreadable" as const,
    runId: LEG_C3_RUN,
    book: BOOK,
    missingSources: ["session-timeline"] as const,
    firstFrameAt: {
      status: "present" as const,
      at: "2026-08-01T00:00:30.000Z",
    },
  },
  {
    kind: "run" as const,
    runId: LEG_B2_RUN,
    book: BOOK,
    role: "judge",
    startedAt: "2026-08-01T00:01:00.000Z",
    endedAt: "2026-08-01T00:01:08.000Z",
    wallMs: 8_000,
    terminal: { kind: "receipt" as const, status: "converged", classCount: 2 },
  },
  {
    kind: "run" as const,
    runId: LEG_E7_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:01:30.000Z",
    endedAt: "2026-08-01T00:01:35.000Z",
    wallMs: 5_000,
    terminal: { kind: "death" as const, channel: "no-receipt" as const },
  },
  {
    kind: "run" as const,
    runId: LEG_E5_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:02:00.000Z",
    endedAt: "2026-08-01T00:03:40.000Z",
    wallMs: 100_000,
    terminal: { kind: "receipt" as const, status: "completed" },
  },
  {
    kind: "run" as const,
    runId: LEG_E6_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:02:00.000Z",
    endedAt: "2026-08-01T00:02:10.000Z",
    wallMs: 10_000,
    terminal: { kind: "receipt" as const, status: "refused" },
  },
  {
    kind: "run" as const,
    runId: LEG_F6_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:03:00.000Z",
    endedAt: "2026-08-01T00:03:05.000Z",
    wallMs: 5_000,
    terminal: { kind: "receipt" as const, status: "planned" },
  },
  {
    kind: "run" as const,
    runId: LEG_A7_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:04:00.000Z",
    endedAt: "2026-08-01T00:04:20.000Z",
    wallMs: 20_000,
    terminal: { kind: "death" as const, channel: "no-receipt" as const },
  },
  {
    kind: "run" as const,
    runId: LEG_B8_RUN,
    book: BOOK,
    role: "reviewer",
    startedAt: "2026-08-01T00:05:00.000Z",
    endedAt: "2026-08-01T00:05:04.000Z",
    wallMs: 4_000,
    terminal: { kind: "receipt" as const, status: "completed" },
  },
  {
    kind: "run" as const,
    runId: LEG_C9_RUN,
    book: BOOK,
    role: "collector",
    startedAt: "2026-08-01T00:06:00.000Z",
    endedAt: "2026-08-01T00:06:06.000Z",
    wallMs: 6_000,
    terminal: { kind: "receipt" as const, status: "collected" },
  },
  {
    kind: "run" as const,
    runId: LEG_D0_RUN,
    book: BOOK,
    role: "doctor",
    startedAt: "2026-08-01T00:07:00.000Z",
    endedAt: "2026-08-01T00:07:03.000Z",
    wallMs: 3_000,
    terminal: { kind: "receipt" as const, status: "completed" },
  },
  {
    kind: "run" as const,
    runId: LEG_E1_RUN,
    book: BOOK,
    role: "merger",
    startedAt: "2026-08-01T00:08:00.000Z",
    endedAt: "2026-08-01T00:08:07.000Z",
    wallMs: 7_000,
    terminal: { kind: "receipt" as const, status: "completed" },
  },
  {
    kind: "run" as const,
    runId: LEG_F2_RUN,
    book: BOOK,
    role: "fixer",
    startedAt: "2026-08-01T00:09:00.000Z",
    endedAt: "2026-08-01T00:09:09.000Z",
    wallMs: 9_000,
    terminal: { kind: "receipt" as const, status: "completed" },
  },
  {
    kind: "run" as const,
    runId: LEG_A3_RUN,
    book: BOOK,
    role: "collector",
    startedAt: "2026-08-01T00:09:30.000Z",
    endedAt: "2026-08-01T00:09:33.000Z",
    wallMs: 3_000,
    terminal: { kind: "receipt" as const, status: "collected" },
  },
  {
    kind: "run" as const,
    runId: LEG_C5_RUN,
    book: BOOK,
    role: "coder",
    startedAt: "2026-08-01T00:11:00.000Z",
    endedAt: "2026-08-01T00:11:12.000Z",
    wallMs: 12_000,
    terminal: { kind: "receipt" as const, status: "partially_completed" },
  },
  {
    kind: "run" as const,
    runId: LEG_D2_RUN,
    book: BOOK,
    role: "judge",
    startedAt: "2026-08-01T00:11:20.000Z",
    endedAt: "2026-08-01T00:11:26.000Z",
    wallMs: 6_000,
    terminal: { kind: "receipt" as const, status: "continue" },
  },
  {
    kind: "run" as const,
    runId: LEG_E3_RUN,
    book: BOOK,
    role: "judge",
    startedAt: "2026-08-01T00:11:30.000Z",
    endedAt: "2026-08-01T00:11:34.000Z",
    wallMs: 4_000,
    terminal: { kind: "receipt" as const, status: "escalate" },
  },
  {
    kind: "unreadable" as const,
    runId: LEG_F7_RUN,
    book: BOOK,
    missingSources: ["session-timeline"] as const,
    firstFrameAt: { status: "absent" as const },
  },
] as const;

test("analyst issue-mode entry: fixture page+static family registry hand-equal; atomic replace idempotent", async () => {
  await withTempHome(async (home) => {
    const ledgerHome = join(home, ".ak-roles");
    const pagePath = analystIssuePagePath(ledgerHome, { bookKey: `root:${physicalPathIdentity(ISSUE_PROJECT_ROOT)}`, scopeRootIdentity: ISSUE_PROJECT_ROOT });

    // Pre-seed a stale page at the canonical path — replace must be atomic/idempotent.
    await mkdir(join(ledgerHome, "analyst", "issues"), { recursive: true });
    await writeFile(
      pagePath,
      `${JSON.stringify({
        kind: "analyst-issue-metrics",
        mode: "issue",
        projectRoot: ISSUE_PROJECT_ROOT,
        legs: [],
        unreadable: [],
        unreadableCount: 0,
        stale: true,
      }, null, 2)}\n`,
      "utf8",
    );

    const first = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });

    assert.equal(first.mode, "issue");
    assert.equal(first.pagePath, pagePath);
    assert.equal(first.page.kind, "analyst-issue-metrics");
    assert.equal(first.page.mode, "issue");
    assert.equal(first.page.projectRoot, physicalPathIdentity(ISSUE_PROJECT_ROOT));

    // Hand-computed leg list (other-issue run excluded; damaged excluded from legs).
    assert.deepEqual(first.page.legs, [...EXPECTED_LEGS]);

    // Production discovery product on the typed page (no internal loader bullet):
    // all live family sections must land; success page never omits the family set.
    const page = first.page as PageWithMetricFamilies;
    assert.ok(
      page.b2FrameBucketsActions,
      "B2 b2FrameBucketsActions must register via family discovery",
    );
    assert.ok(page.roundTimeline, "B4 roundTimeline must register via family discovery");

    // B1: ranking/median/total hand-equal; damaged excluded from ranking.
    assert.deepEqual(page.legWallClock, EXPECTED_LEG_WALL_CLOCK);

    // B4: per-lane round timeline hand-equal (receipt / death / unreadable placeholder).
    assert.equal(page.roundTimeline.kind, "analyst-round-timeline");
    assert.equal(page.roundTimeline.lanes.length, 3);
    const bookLane = page.roundTimeline.lanes.find((lane) => lane.lane === BOOK);
    assert.ok(bookLane, "fixture-book lane must appear on B4 timeline");
    assert.equal(bookLane.rows.length, EXPECTED_ROUND_TIMELINE_BOOK_ROWS.length);
    for (let i = 0; i < EXPECTED_ROUND_TIMELINE_BOOK_ROWS.length; i += 1) {
      const expected = EXPECTED_ROUND_TIMELINE_BOOK_ROWS[i]!;
      const actual: AnalystRoundTimelineRow = bookLane.rows[i]!;
      if (expected.kind === "unreadable") {
        assert.equal(actual.kind, "unreadable");
        if (actual.kind !== "unreadable") continue;
        assert.equal(actual.runId, expected.runId);
        assert.equal(actual.book, expected.book);
        assert.deepEqual(actual.missingSources, [...expected.missingSources]);
        assert.ok(actual.reason.trim().length > 0);
        assert.deepEqual(actual.firstFrameAt, expected.firstFrameAt);
      } else {
        assert.deepEqual(actual, expected);
      }
    }

    // B3: acceptance/success sets, rework lens, first-pass — hand oracle equality.
    assert.deepEqual(page.acceptanceSuccessRework, EXPECTED_B3);

    // Damaged runs: loud unreadable exclusion + count; duration not on page.
    // Present-first-frame (c3) and absent-first-frame (f7) both retained.
    assert.equal(first.page.unreadableCount, EXPECTED_UNREADABLE.length);
    assert.equal(first.page.unreadable.length, EXPECTED_UNREADABLE.length);
    for (let i = 0; i < EXPECTED_UNREADABLE.length; i += 1) {
      const expected = EXPECTED_UNREADABLE[i]!;
      const damaged = first.page.unreadable[i]!;
      assert.equal(damaged.runId, expected.runId);
      assert.equal(damaged.book, expected.book);
      assert.deepEqual(damaged.missingSources, [...expected.missingSources]);
      assert.ok(damaged.reason.trim().length > 0);
      assert.deepEqual(damaged.firstFrameAt, expected.firstFrameAt);
      // No wall-clock / duration field admitted for unreadable runs on A1 page.
      assert.equal(
        "wallMs" in damaged || "durationMs" in damaged || "elapsedMs" in damaged,
        false,
      );
    }

    const onDisk = JSON.parse(await readFile(pagePath, "utf8")) as AnalystIssueMetricsPage;
    assert.deepEqual(onDisk, first.page);
    assert.equal("stale" in (onDisk as unknown as Record<string, unknown>), false);
    assert.equal("version" in (onDisk as unknown as Record<string, unknown>), false);

    // Atomic replace idempotent: second run yields equivalent page bytes/content.
    const firstBytes = await readFile(pagePath, "utf8");
    const second = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });
    assert.deepEqual(second.page, first.page);
    assert.equal(await readFile(pagePath, "utf8"), firstBytes);
    const onDiskAgain = JSON.parse(await readFile(pagePath, "utf8")) as AnalystIssueMetricsPage;
    assert.deepEqual(onDiskAgain, first.page);
  });
});

/**
 * Public single-bundle regression: dist/public-cli/main.js must assemble B1–B4
 * without a sibling analyst-metric-families/ directory next to the bin.
 */

test("analyst issue-mode entry: null terminal artifact is terminal-artifact unreadable and excluded from legs", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, ".ak-roles", "books", BOOK, "runs", LEG_A1_DIR);
    // A terminal section with no typed object body.
    seedTerminal(runDirectory, "report", null);

    const result = await runAnalyst({
      mode: "issue",
      projectRoot: ISSUE_PROJECT_ROOT,
    }, { home });

    assert.equal(
      result.page.legs.some((leg) => leg.runId === LEG_A1_RUN),
      false,
      "run with null terminal artifact must leave legs",
    );
    const entry = result.page.unreadable.find((u) => u.runId === LEG_A1_RUN);
    assert.ok(entry, "null terminal artifact must produce unreadable entry");
    assert.deepEqual(entry.missingSources, ["terminal-artifact"]);
    assert.ok(entry.reason.trim().length > 0);
    // Session span was admitted before terminal failure — first frame stays present.
    assert.deepEqual(entry.firstFrameAt, {
      status: "present",
      at: "2026-08-01T00:00:00.000Z",
    });
    // Fixture session-damaged runs remain; plus this terminal-artifact failure.
    assert.equal(result.page.unreadableCount, EXPECTED_UNREADABLE.length + 1);
    assert.equal(result.page.unreadable.length, EXPECTED_UNREADABLE.length + 1);
    // Other readable fixture legs remain (B2/B3/B4 expansion); only a1 leaves legs.
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
    assert.ok(
      result.page.legs.some((leg) => leg.runId === LEG_E7_RUN),
      "B4 death e7 must remain when only coder a1 terminal is null",
    );
  });
});

test("analyst B3 and B4 use the same receipt status when outcome status is absent", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, ".ak-roles", "books", BOOK, "runs", LEG_A1_DIR);
    seedTerminal(runDirectory, "report", {
      role: "coder",
      runId: LEG_A1_RUN,
      receipt: { status: "completed" },
    });

    const result = await runAnalyst({ mode: "issue", projectRoot: ISSUE_PROJECT_ROOT }, { home });
    const page = result.page as PageWithMetricFamilies;
    const b3 = page.acceptanceSuccessRework?.legs.find((leg) => leg.runId === LEG_A1_RUN);
    const b4Row = page.roundTimeline?.lanes
      .flatMap((lane) => lane.rows)
      .find((row) => row.kind === "run" && row.runId === LEG_A1_RUN);

    assert.equal(b3?.terminalLabel, "completed");
    assert.ok(b4Row && b4Row.kind === "run");
    if (b4Row?.kind === "run") assert.deepEqual(b4Row.terminal, { kind: "receipt", status: "completed" });
  });
});

test("analyst entry does not turn a malformed live run state into no-receipt", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, ".ak-roles", "books", BOOK, "runs", LEG_A1_DIR);
    clearCurrentSection(runDirectory, "terminal");
    // Same illegal value as the pre-move current.json runState: the string "{broken".
    // Fact path is state.jsonl (#1161); do not change the failure shape into an object.
    appendFileSync(
      join(runDirectory, "state.jsonl"),
      `${JSON.stringify({
        level: "event",
        kind: "run-state",
        identity: randomUUID(),
        timestamp: "2026-10-04T00:00:00.000Z",
        host: "pi",
        source: "test-seed",
        payload: "{broken",
      })}\n`,
      "utf8",
    );

    const result = await runAnalyst({ mode: "issue", projectRoot: ISSUE_PROJECT_ROOT }, { home });
    const damaged = result.page.unreadable.find((run) => run.runId === LEG_A1_RUN);
    assert.deepEqual(damaged?.missingSources, ["run-state"]);
    assert.ok((damaged?.reason ?? "").trim().length > 0);
  });
});

test("analyst entry does not turn an incomplete live run state into no-receipt", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, ".ak-roles", "books", BOOK, "runs", LEG_A1_DIR);
    clearCurrentSection(runDirectory, "terminal");
    seedCurrentSection(runDirectory, "runState", { state: "running" });

    const result = await runAnalyst({ mode: "issue", projectRoot: ISSUE_PROJECT_ROOT }, { home });
    const damaged = result.page.unreadable.find((run) => run.runId === LEG_A1_RUN);
    assert.deepEqual(damaged?.missingSources, ["run-state"]);
    assert.ok((damaged?.reason ?? "").trim().length > 0);
  });
});

test("analyst issue-mode entry: analyst path symlink into consumer repo is refused without porcelain change", async () => {
  await withBusinessRepo(async (businessRepo) => {
    await withTempHome(async (home) => {
      const ledgerHome = join(home, ".ak-roles");
      await symlink(businessRepo, join(ledgerHome, "analyst"));

      await assert.rejects(
        () =>
          runAnalyst({
            mode: "issue",
            projectRoot: ISSUE_PROJECT_ROOT,
          }, { home }),
        (error: unknown) => {
          return error instanceof ActivationLedgerError;
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
