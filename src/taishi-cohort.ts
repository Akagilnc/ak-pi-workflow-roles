/**
 * Taishi cohort contrast aggregation (ADR 0068 / PRD #298 output ③ / #330 / #338).
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
 * - index hit + missing page → ensure (compute-if-missing); ensure failure stays loud
 *   (never washed into absent) — owner 2026-08-14 #338.
 */
import {
  findTaishiLibraryIndexRow,
  readTaishiLibraryIndexPage,
  type TaishiLibraryIndexPage,
} from "./taishi-index.ts";
import { medianNumber } from "./taishi-median.ts";
import type { TaishiIssueMetricsPage } from "./taishi-page.ts";
import type { TaishiRoleAcceptanceStats } from "./taishi-metric-families/acceptance-success-rework.ts";
import type { TaishiLegWallClockSection } from "./taishi-metric-families/leg-wall-clock.ts";
import type { TaishiAcceptanceSuccessReworkSection } from "./taishi-metric-families/acceptance-success-rework.ts";

/**
 * #338 page ensurer — read existing page or compute via sole issue kernel.
 * Injected by the entry so cohort never opens a second compute route.
 */
export type TaishiIssuePageEnsuring = (input: {
  readonly projectRoot: string;
  readonly issueNumber: number;
}) => Promise<TaishiIssueMetricsPage>;

/** LOC-style optional metric — never encode absence as 0 or Infinity. */
export type TaishiCohortOptionalMetric =
  | { readonly status: "present"; readonly value: number }
  | { readonly status: "absent" };

export type TaishiCohortGroupInput = {
  readonly groupLabel: string;
  /** Issue numbers (caller typed); join key into the library index. */
  readonly issues: readonly number[];
};

export type TaishiCohortModeInput = {
  readonly mode: "cohort";
  /** Exactly two groups side-by-side (before/after etc. — caller labels). */
  readonly groups: readonly [TaishiCohortGroupInput, TaishiCohortGroupInput];
};

/** Per-issue join face: index hit + readable page → present; index miss → typed vacancy. */
export type TaishiCohortIssueEntry =
  | {
      readonly issueNumber: number;
      readonly status: "present";
      readonly projectRoot: string;
    }
  | {
      readonly issueNumber: number;
      readonly status: "absent";
    };

/** Per-role contrast stats within one cohort group. */
export type TaishiCohortRoleStats = {
  readonly role: string;
  /** Concatenated lane×role call-count samples across present issues. */
  readonly convergenceRounds: readonly number[];
  readonly convergenceRoundsMedian: TaishiCohortOptionalMetric;
  readonly firstPassRate: TaishiCohortOptionalMetric;
  readonly successRate: TaishiCohortOptionalMetric;
};

export type TaishiCohortGroupResult = {
  readonly groupLabel: string;
  /** One entry per input issue number, in input order (vacancy single-listed). */
  readonly issues: readonly TaishiCohortIssueEntry[];
  readonly byRole: readonly TaishiCohortRoleStats[];
  readonly reworkRatio: TaishiCohortOptionalMetric;
  readonly medianWallMs: TaishiCohortOptionalMetric;
};

export type TaishiCohortModeResult = {
  readonly mode: "cohort";
  readonly groups: readonly [TaishiCohortGroupResult, TaishiCohortGroupResult];
};

/** Issue page shape cohort actually reads (envelope + B-family sections). */
type TaishiCohortSourcePage = TaishiIssueMetricsPage & {
  readonly acceptanceSuccessRework?: TaishiAcceptanceSuccessReworkSection;
  readonly legWallClock?: TaishiLegWallClockSection;
};

const ABSENT: TaishiCohortOptionalMetric = { status: "absent" };

function presentMetric(value: number): TaishiCohortOptionalMetric {
  return { status: "present", value };
}

function rateMetric(numerator: number, denominator: number): TaishiCohortOptionalMetric {
  if (denominator === 0) return ABSENT;
  return presentMetric(numerator / denominator);
}

function optionalMedian(values: readonly number[]): TaishiCohortOptionalMetric {
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

function absorbRole(accum: RoleAccum, stats: TaishiRoleAcceptanceStats): void {
  accum.convergenceRounds.push(...stats.convergenceRounds);
  accum.firstPassLaneCount += stats.firstPassLaneCount;
  accum.appearanceLaneCount += stats.appearanceLaneCount;
  accum.successCount += stats.successCount;
  accum.successEligibleCount += stats.successEligibleCount;
}

function finishRole(role: string, accum: RoleAccum): TaishiCohortRoleStats {
  return {
    role,
    convergenceRounds: accum.convergenceRounds,
    convergenceRoundsMedian: optionalMedian(accum.convergenceRounds),
    firstPassRate: rateMetric(accum.firstPassLaneCount, accum.appearanceLaneCount),
    successRate: rateMetric(accum.successCount, accum.successEligibleCount),
  };
}

async function aggregateGroup(
  index: TaishiLibraryIndexPage | undefined,
  input: TaishiCohortGroupInput,
  ensureIssuePage: TaishiIssuePageEnsuring,
): Promise<TaishiCohortGroupResult> {
  const issueEntries: TaishiCohortIssueEntry[] = [];
  const roleAccums = new Map<string, RoleAccum>();
  let reworkWallMs = 0;
  let totalWallMs = 0;
  let hasReworkSample = false;
  const legWalls: number[] = [];

  for (const issueNumber of input.issues) {
    const row = findTaishiLibraryIndexRow(index, issueNumber);
    if (row === undefined) {
      // Only "index has no such row" is typed vacancy.
      issueEntries.push({ issueNumber, status: "absent" });
      continue;
    }

    // Index hit: ensure page via sole compute-if-missing kernel (read or compute).
    // Ensure failure stays loud with issue identity — never washed to absent.
    const page = (await ensureIssuePage({
      projectRoot: row.projectRoot,
      issueNumber,
    })) as TaishiCohortSourcePage;

    issueEntries.push({
      issueNumber,
      status: "present",
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
  }

  const byRole = [...roleAccums.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((role) => finishRole(role, roleAccums.get(role)!));

  return {
    groupLabel: input.groupLabel,
    issues: issueEntries,
    byRole,
    reworkRatio: hasReworkSample ? rateMetric(reworkWallMs, totalWallMs) : ABSENT,
    medianWallMs: optionalMedian(legWalls),
  };
}

/**
 * Run cohort contrast: join index by issueNumber, ensure pages (#338), fold,
 * emit two side-by-side group results. Page writes happen only through the
 * injected ensurer (sole issue kernel + existing writer) — cohort itself is
 * not a second compute kernel or projection.
 */
export async function runTaishiCohortMode(
  ledgerHome: string,
  input: TaishiCohortModeInput,
  ensureIssuePage: TaishiIssuePageEnsuring,
): Promise<TaishiCohortModeResult> {
  const index = await readTaishiLibraryIndexPage(ledgerHome);
  const group0 = await aggregateGroup(index, input.groups[0], ensureIssuePage);
  const group1 = await aggregateGroup(index, input.groups[1], ensureIssuePage);
  return {
    mode: "cohort",
    groups: [group0, group1],
  };
}
