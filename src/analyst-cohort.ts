/**
 * Analyst cohort contrast aggregation (ADR 0068 / PRD #298 output ③ / #330 / #338).
 *
 * Query product — joins the library index, ensures each hit has a metrics page
 * (compute-if-missing via caller-supplied sole issue kernel), then folds pages.
 * No second ledger scan, no second parse kernel, no persistence of the contrast.
 *
 * Aggregation nails (ticket #330):
 * - ratios (first-pass / success / rework): merge numerators & denominators
 * - convergence rounds sample = one per lane×role (page byRole.convergenceRounds)
 * - leg wall-clock median sample = one per leg (page legWallClock.ranking)
 * - missing index row / zero denominator → typed 空缺 (LOC vacancy shape)
 * - index hit + missing page → sync ensure (compute-if-missing); ensure failure is
 *   typed terminal for this pull (never washed into absent/pending) — #338.
 * - single-run unreadable on a page stays page-local exclusion, not whole failure.
 */
import {
  findAnalystLibraryIndexRow,
  readAnalystLibraryIndexPage,
  type AnalystLibraryIndexPage,
} from "./analyst-index.ts";
import { medianNumber } from "./analyst-median.ts";
import type { AnalystIssueMetricsPage } from "./analyst-page.ts";
import type { AnalystRoleAcceptanceStats } from "./analyst-metric-families/acceptance-success-rework.ts";
import type { AnalystLegWallClockSection } from "./analyst-metric-families/leg-wall-clock.ts";
import type { AnalystAcceptanceSuccessReworkSection } from "./analyst-metric-families/acceptance-success-rework.ts";
import type { AnalystGateCyclesSection } from "./analyst-metric-families/gate-cycles.ts";

/**
 * #338 page ensurer — read existing page or compute via sole issue kernel.
 * Injected by the entry so cohort never opens a second compute route.
 */
export type AnalystIssuePageEnsuring = (input: {
  readonly projectRoot: string;
  readonly issueNumber: number;
  readonly bookKey?: string;
}) => Promise<AnalystIssueMetricsPage>;

/** LOC-style optional metric — never encode absence as 0 or Infinity. */
export type AnalystCohortOptionalMetric =
  | { readonly status: "present"; readonly value: number }
  | { readonly status: "absent" };

/** Fully resolved cohort issue identity — book is always explicit at the library face. */
export type AnalystCohortIssueRef = {
  readonly bookKey: string;
  readonly issueNumber: number;
};

export type AnalystCohortGroupInput = {
  readonly groupLabel: string;
  /** (bookKey, issueNumber) pairs; join key into the library index (#412). */
  readonly issues: readonly AnalystCohortIssueRef[];
};

export type AnalystCohortModeInput = {
  readonly mode: "cohort";
  /** Exactly two groups side-by-side (before/after etc. — caller labels). */
  readonly groups: readonly [AnalystCohortGroupInput, AnalystCohortGroupInput];
};

/** Per-issue join face: index hit + readable page → present; index miss → typed vacancy. */
export type AnalystCohortIssueEntry =
  | {
      readonly issueNumber: number;
      readonly status: "present";
      readonly bookKey: string;
      readonly projectRoot: string;
    }
  | {
      readonly issueNumber: number;
      readonly status: "absent";
      /** Requested book scope — cross-book same-number vacancies stay self-describing (#413 r2 U4). */
      readonly bookKey: string;
    };

/** Per-role contrast stats within one cohort group. */
export type AnalystCohortRoleStats = {
  readonly role: string;
  /** Concatenated lane×role call-count samples across present issues. */
  readonly convergenceRounds: readonly number[];
  readonly convergenceRoundsMedian: AnalystCohortOptionalMetric;
  readonly firstPassRate: AnalystCohortOptionalMetric;
  readonly successRate: AnalystCohortOptionalMetric;
};

/** Per-officer gate-cycle contrast stats within one cohort group (#446). */
export type AnalystCohortGateOfficerStats = {
  readonly officer: "inspector" | "notary";
  /** Merged paired-round count across present issues. */
  readonly rounds: number;
  readonly bounceCount: number;
  readonly passCount: number;
  /** bounceCount / rounds; absent when rounds === 0. */
  readonly bounceRate: AnalystCohortOptionalMetric;
  /** Mean officer subsession wall across merged rounds; absent when rounds === 0. */
  readonly meanOfficerWallMs: AnalystCohortOptionalMetric;
};

export type AnalystCohortGroupResult = {
  readonly groupLabel: string;
  /** One entry per input issue number, in input order (vacancy single-listed). */
  readonly issues: readonly AnalystCohortIssueEntry[];
  readonly byRole: readonly AnalystCohortRoleStats[];
  readonly reworkRatio: AnalystCohortOptionalMetric;
  readonly medianWallMs: AnalystCohortOptionalMetric;
  /**
   * Gate-cycle by-officer fold from ensured issue pages (#446).
   * Empty when no present page contributed a gateCycles section with rounds.
   */
  readonly gateCyclesByOfficer: readonly AnalystCohortGateOfficerStats[];
};

export type AnalystCohortModeResult = {
  readonly mode: "cohort";
  readonly groups: readonly [AnalystCohortGroupResult, AnalystCohortGroupResult];
};

/** Issue page shape cohort actually reads (envelope + metric-family sections). */
type AnalystCohortSourcePage = AnalystIssueMetricsPage & {
  readonly acceptanceSuccessRework?: AnalystAcceptanceSuccessReworkSection;
  readonly legWallClock?: AnalystLegWallClockSection;
  readonly gateCycles?: AnalystGateCyclesSection;
};

const ABSENT: AnalystCohortOptionalMetric = { status: "absent" };

function presentMetric(value: number): AnalystCohortOptionalMetric {
  return { status: "present", value };
}

function rateMetric(numerator: number, denominator: number): AnalystCohortOptionalMetric {
  if (denominator === 0) return ABSENT;
  return presentMetric(numerator / denominator);
}

function optionalMedian(values: readonly number[]): AnalystCohortOptionalMetric {
  const median = medianNumber(values);
  return median === undefined ? ABSENT : presentMetric(median);
}

type RoleAccum = {
  convergenceRounds: number[];
  firstPassLaneCount: number;
  appearanceLaneCount: number;
  successCount: number;
  successEligibleCount: number;
};

function emptyRoleAccum(): RoleAccum {
  return {
    convergenceRounds: [],
    firstPassLaneCount: 0,
    appearanceLaneCount: 0,
    successCount: 0,
    successEligibleCount: 0,
  };
}

function absorbRole(accum: RoleAccum, stats: AnalystRoleAcceptanceStats): void {
  accum.convergenceRounds.push(...stats.convergenceRounds);
  accum.firstPassLaneCount += stats.firstPassLaneCount;
  accum.appearanceLaneCount += stats.appearanceLaneCount;
  accum.successCount += stats.successCount;
  accum.successEligibleCount += stats.successEligibleCount;
}

function finishRole(role: string, accum: RoleAccum): AnalystCohortRoleStats {
  return {
    role,
    convergenceRounds: accum.convergenceRounds,
    convergenceRoundsMedian: optionalMedian(accum.convergenceRounds),
    firstPassRate: rateMetric(accum.firstPassLaneCount, accum.appearanceLaneCount),
    successRate: rateMetric(accum.successCount, accum.successEligibleCount),
  };
}

/**
 * Cross-page fold of page-level gateCycles.byOfficer numerators (#446).
 * status→bounce/pass classification stays sole in gate-cycles family;
 * cohort only merges already-projected counts (same ratio-merge nail as rework).
 */
type GateOfficerNumeratorAccum = {
  rounds: number;
  bounceCount: number;
  passCount: number;
  /** Σ (meanOfficerWallMs × rounds) recovered from page summaries. */
  wallSum: number;
};

function emptyGateOfficerNumeratorAccum(): GateOfficerNumeratorAccum {
  return { rounds: 0, bounceCount: 0, passCount: 0, wallSum: 0 };
}

function absorbGateOfficerSummary(
  accum: GateOfficerNumeratorAccum,
  summary: {
    readonly rounds: number;
    readonly bounceCount: number;
    readonly passCount: number;
    readonly meanOfficerWallMs: number | undefined;
  },
): void {
  accum.rounds += summary.rounds;
  accum.bounceCount += summary.bounceCount;
  accum.passCount += summary.passCount;
  if (summary.meanOfficerWallMs !== undefined) {
    accum.wallSum += summary.meanOfficerWallMs * summary.rounds;
  }
}

function finishGateOfficerNumerators(
  officer: "inspector" | "notary",
  accum: GateOfficerNumeratorAccum,
): AnalystCohortGateOfficerStats {
  return {
    officer,
    rounds: accum.rounds,
    bounceCount: accum.bounceCount,
    passCount: accum.passCount,
    bounceRate: rateMetric(accum.bounceCount, accum.rounds),
    meanOfficerWallMs:
      accum.rounds === 0 ? ABSENT : presentMetric(accum.wallSum / accum.rounds),
  };
}

async function aggregateGroup(
  index: AnalystLibraryIndexPage | undefined,
  input: AnalystCohortGroupInput,
  ensureIssuePage: AnalystIssuePageEnsuring,
): Promise<AnalystCohortGroupResult> {
  const issueEntries: AnalystCohortIssueEntry[] = [];
  const roleAccums = new Map<string, RoleAccum>();
  const gateOfficerAccums = new Map<
    "inspector" | "notary",
    GateOfficerNumeratorAccum
  >();
  let reworkWallMs = 0;
  let totalWallMs = 0;
  let hasReworkSample = false;
  const legWalls: number[] = [];

  for (const ref of input.issues) {
    const { issueNumber, bookKey } = ref;
    const row = findAnalystLibraryIndexRow(index, issueNumber, bookKey);
    if (row === undefined) {
      // Only "index has no such row in this book" is typed vacancy.
      // The requested bookKey rides along so book-a:12 and book-b:12 absences
      // are distinguishable (#413 r2 U4).
      issueEntries.push({ issueNumber, status: "absent", bookKey });
      continue;
    }

    // Index hit: ensure page via sole compute-if-missing kernel (read or compute).
    // Ensure failure stays loud with issue identity — never washed to absent.
    // row.bookKey is normalized at index read — present projection always carries it (F3).
    const page = (await ensureIssuePage({
      projectRoot: row.projectRoot,
      issueNumber,
      bookKey: row.bookKey,
    })) as AnalystCohortSourcePage;

    issueEntries.push({
      issueNumber,
      status: "present",
      bookKey: row.bookKey,
      projectRoot: row.projectRoot,
    });

    const acceptance = page.acceptanceSuccessRework;
    if (acceptance !== undefined) {
      for (const roleStats of acceptance.byRole) {
        const accum = roleAccums.get(roleStats.role) ?? emptyRoleAccum();
        absorbRole(accum, roleStats);
        roleAccums.set(roleStats.role, accum);
      }
      reworkWallMs += acceptance.rework.reworkWallMs;
      totalWallMs += acceptance.rework.totalWallMs;
      hasReworkSample = true;
    }

    const legWallClock = page.legWallClock;
    if (legWallClock !== undefined) {
      for (const leg of legWallClock.ranking) {
        legWalls.push(leg.wallMs);
      }
    }

    // Gate-cycle fold: merge page-projected byOfficer numerators (no rescan,
    // no second status→bounce/pass classifier — sole owner is gate-cycles family).
    const gateCycles = page.gateCycles;
    if (gateCycles !== undefined) {
      for (const summary of gateCycles.byOfficer) {
        const accum =
          gateOfficerAccums.get(summary.officer) ?? emptyGateOfficerNumeratorAccum();
        absorbGateOfficerSummary(accum, summary);
        gateOfficerAccums.set(summary.officer, accum);
      }
    }
  }

  const byRole = [...roleAccums.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((role) => finishRole(role, roleAccums.get(role)!));

  const gateCyclesByOfficer = (["inspector", "notary"] as const)
    .filter((officer) => gateOfficerAccums.has(officer))
    .map((officer) =>
      finishGateOfficerNumerators(officer, gateOfficerAccums.get(officer)!),
    );

  return {
    groupLabel: input.groupLabel,
    issues: issueEntries,
    byRole,
    reworkRatio: hasReworkSample ? rateMetric(reworkWallMs, totalWallMs) : ABSENT,
    medianWallMs: optionalMedian(legWalls),
    gateCyclesByOfficer,
  };
}

/**
 * Run cohort contrast: join index by (bookKey, issueNumber), ensure pages (#338), fold,
 * emit two side-by-side group results. Page writes happen only through the
 * injected ensurer (sole issue kernel + existing writer) — cohort itself is
 * not a second compute kernel or projection.
 */
export async function runAnalystCohortMode(
  ledgerHome: string,
  input: AnalystCohortModeInput,
  ensureIssuePage: AnalystIssuePageEnsuring,
): Promise<AnalystCohortModeResult> {
  const index = await readAnalystLibraryIndexPage(ledgerHome);
  const group0 = await aggregateGroup(index, input.groups[0], ensureIssuePage);
  const group1 = await aggregateGroup(index, input.groups[1], ensureIssuePage);
  return {
    mode: "cohort",
    groups: [group0, group1],
  };
}
