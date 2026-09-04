/**
 * Gate-cycle metric family (#446).
 *
 * Consumes sole-scan retained gateCycles facts only — no second ledger scan.
 * Emits per-leg round counts / officer wall / terminal status, plus by-officer
 * bounce rate and mean officer wall. findings prose is never read (count only).
 */
import type {
  AnalystGateCycleOrigin,
  AnalystGateCycleRound,
} from "../analyst-gate-cycles-read.ts";
import type { AnalystReadableRunFacts } from "../analyst-ledger.ts";
import type { AnalystMetricFamilyModule } from "../analyst-metric-family.ts";

export type AnalystGateCyclesRoundRow = {
  readonly roundIndex: number;
  readonly officer: "inspector" | "notary";
  readonly status: string;
  readonly officerWallMs: number;
  readonly findingsCount: number;
  /** Direct summons vs historical province-paired dispatch. */
  readonly origin: AnalystGateCycleOrigin;
};

export type AnalystGateCyclesLeg = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  /** Paired dispatch↔officer volume count (0 when no auditor-roles). */
  readonly roundCount: number;
  readonly rounds: readonly AnalystGateCyclesRoundRow[];
};

export type AnalystGateCyclesOfficerSummary = {
  readonly officer: "inspector" | "notary";
  readonly rounds: number;
  readonly bounceCount: number;
  readonly passCount: number;
  /**
   * bounceCount / rounds. Absent when rounds === 0 (never encode as 0 rate
   * with empty denominator).
   */
  readonly bounceRate: number | undefined;
  /** Mean officer subsession wall across this officer's rounds; absent if none. */
  readonly meanOfficerWallMs: number | undefined;
};

export type AnalystGateCyclesSection = {
  readonly kind: "analyst-gate-cycles";
  readonly legs: readonly AnalystGateCyclesLeg[];
  readonly byOfficer: readonly AnalystGateCyclesOfficerSummary[];
};

function projectRound(round: AnalystGateCycleRound): AnalystGateCyclesRoundRow {
  return {
    roundIndex: round.roundIndex,
    officer: round.officer,
    status: round.status,
    officerWallMs: round.officerWallMs,
    findingsCount: round.findingsCount,
    origin: round.origin,
  };
}

function projectLeg(facts: AnalystReadableRunFacts): AnalystGateCyclesLeg {
  const rounds = facts.gateCycles.map(projectRound);
  return {
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
    roundCount: rounds.length,
    rounds,
  };
}

function compareLegs(a: AnalystGateCyclesLeg, b: AnalystGateCyclesLeg): number {
  if (a.book !== b.book) return a.book.localeCompare(b.book);
  if (a.role !== b.role) return a.role.localeCompare(b.role);
  return a.runId.localeCompare(b.runId);
}

type OfficerAccum = {
  rounds: number;
  bounceCount: number;
  passCount: number;
  wallSum: number;
};

function emptyAccum(): OfficerAccum {
  return { rounds: 0, bounceCount: 0, passCount: 0, wallSum: 0 };
}

function absorbRound(accum: OfficerAccum, round: AnalystGateCyclesRoundRow): void {
  accum.rounds += 1;
  accum.wallSum += round.officerWallMs;
  if (round.status === "bounce") accum.bounceCount += 1;
  if (round.status === "pass") accum.passCount += 1;
}

function finishOfficer(
  officer: "inspector" | "notary",
  accum: OfficerAccum,
): AnalystGateCyclesOfficerSummary {
  return {
    officer,
    rounds: accum.rounds,
    bounceCount: accum.bounceCount,
    passCount: accum.passCount,
    bounceRate: accum.rounds === 0 ? undefined : accum.bounceCount / accum.rounds,
    meanOfficerWallMs: accum.rounds === 0 ? undefined : accum.wallSum / accum.rounds,
  };
}

function summarizeByOfficer(
  legs: readonly AnalystGateCyclesLeg[],
): readonly AnalystGateCyclesOfficerSummary[] {
  const byOfficer = new Map<"inspector" | "notary", OfficerAccum>();
  for (const leg of legs) {
    for (const round of leg.rounds) {
      const accum = byOfficer.get(round.officer) ?? emptyAccum();
      absorbRound(accum, round);
      byOfficer.set(round.officer, accum);
    }
  }
  // Stable officer order; only officers that appeared on the board.
  const officers = (["inspector", "notary"] as const).filter((o) => byOfficer.has(o));
  return officers.map((officer) => finishOfficer(officer, byOfficer.get(officer)!));
}

/** Discovered by analyst-metric-families loader (default export). */
const gateCyclesFamily: AnalystMetricFamilyModule = {
  id: "gate-cycles",
  contribute(input) {
    if (input.runs.length === 0) return undefined;
    const legs = input.runs.map(projectLeg).sort(compareLegs);
    const section: AnalystGateCyclesSection = {
      kind: "analyst-gate-cycles",
      legs,
      byOfficer: summarizeByOfficer(legs),
    };
    return { gateCycles: section };
  },
};

export default gateCyclesFamily;
