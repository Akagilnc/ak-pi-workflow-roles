/**
 * B3 metric family: acceptance terminal mapping, rework lens, first-pass / success rates.
 *
 * Consumes only A2 typed per-run facts (frame span + terminal face). Drop-in
 * registration via analyst-metric-families/ discovery — no shared skeleton edits.
 *
 * Denominator contract (PRD #298 + ticket #327 票面补正):
 * - first-pass rate den = appearance lanes (no-receipt first call stays in den)
 * - success rate den = success-eligible accepted legs (no-receipt out; planned out)
 * - planned = plan-duty acceptance; never success numerator or denominator
 */
import type { AnalystReadableRunFacts, AnalystRunTerminalFace } from "../analyst-ledger.ts";
import { medianNumber } from "../analyst-median.ts";
import type { AnalystMetricFamilyModule } from "../analyst-metric-family.ts";

const WORKER_ROLES = new Set(["coder", "fixer"]);

/** Lawful acceptance vocabulary by role (PRD 受理终态映射). */
const ACCEPTED_STATUS: Readonly<Record<string, ReadonlySet<string>>> = {
  coder: new Set(["completed", "refused", "partially_completed", "unfinished", "planned"]),
  fixer: new Set(["completed", "refused", "partially_completed", "unfinished", "planned"]),
  judge: new Set(["converged", "continue", "escalate"]),
  reviewer: new Set(["completed", "refused"]),
  doctor: new Set(["completed", "refused"]),
  merger: new Set(["completed", "escalate"]),
};

/** Success vocabulary by role (PRD 成功集合). planned excluded for workers. */
const SUCCESS_STATUS: Readonly<Record<string, ReadonlySet<string>>> = {
  coder: new Set(["completed"]),
  fixer: new Set(["completed"]),
  // Judge: producing any of the three verdicts completes the duty.
  judge: new Set(["converged", "continue", "escalate"]),
  reviewer: new Set(["completed"]),
  doctor: new Set(["completed"]),
  merger: new Set(["completed"]),
};

export type AnalystTerminalMapLabel =
  | "no-receipt"
  | "non-accepted"
  | "groups"
  | string;

export type AnalystAcceptanceLeg = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly startedAt: string;
  readonly wallMs: number;
  /** Mapped terminal label (status token, groups, no-receipt, non-accepted). */
  readonly terminalLabel: AnalystTerminalMapLabel;
  readonly accepted: boolean;
  /** In success set (and therefore success numerator when eligible). */
  readonly success: boolean;
  /** In success-rate denominator (accepted ∧ ¬planned-duty). */
  readonly successEligible: boolean;
  readonly noReceipt: boolean;
  /** 1-based ordinal among same lane+role ordered by startedAt. */
  readonly ordinalInLaneRole: number;
  readonly rework: boolean;
};

export type AnalystRoleAcceptanceStats = {
  readonly role: string;
  readonly acceptedCount: number;
  readonly successEligibleCount: number;
  readonly successCount: number;
  readonly noReceiptCount: number;
  /** successCount / successEligibleCount; undefined when denominator is 0. */
  readonly successRate: number | undefined;
  readonly appearanceLaneCount: number;
  readonly firstPassLaneCount: number;
  /** firstPassLaneCount / appearanceLaneCount; undefined when denominator is 0. */
  readonly firstPassRate: number | undefined;
  /** Per appearance-lane call counts (convergence rounds). */
  readonly convergenceRounds: readonly number[];
  readonly convergenceRoundsMedian: number | undefined;
};

export type AnalystReworkLens = {
  readonly reworkWallMs: number;
  readonly totalWallMs: number;
  /** reworkWallMs / totalWallMs; undefined when totalWallMs is 0. */
  readonly reworkRatio: number | undefined;
  readonly reworkLegCount: number;
  readonly totalLegCount: number;
};

export type AnalystAcceptanceSuccessReworkSection = {
  readonly kind: "analyst-acceptance-success-rework";
  readonly legs: readonly AnalystAcceptanceLeg[];
  readonly byRole: readonly AnalystRoleAcceptanceStats[];
  readonly rework: AnalystReworkLens;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wallMsFromSpan(span: { readonly startedAt: string; readonly endedAt: string }): number {
  return Date.parse(span.endedAt) - Date.parse(span.startedAt);
}

/** Locate collector groups array: receipt.groups or top-level groups. */
function findCollectorGroups(body: Record<string, unknown>): unknown {
  if (Array.isArray(body.groups)) return body.groups;
  const receipt = body.receipt;
  if (isRecord(receipt) && Array.isArray(receipt.groups)) return receipt.groups;
  const outcome = body.outcome;
  if (isRecord(outcome)) {
    const facts = outcome.decisiveFacts;
    if (isRecord(facts) && Array.isArray(facts.groups)) return facts.groups;
  }
  return undefined;
}

/** Extract role receipt status from canonical terminal body faces. */
function extractStatus(body: Record<string, unknown>): string | undefined {
  const outcome = body.outcome;
  if (isRecord(outcome) && typeof outcome.status === "string" && outcome.status.trim() !== "") {
    return outcome.status;
  }
  const receipt = body.receipt;
  if (isRecord(receipt) && typeof receipt.status === "string" && receipt.status.trim() !== "") {
    return receipt.status;
  }
  if (typeof body.status === "string" && body.status.trim() !== "") {
    return body.status;
  }
  return undefined;
}

function mapTerminal(
  role: string,
  terminal: AnalystRunTerminalFace,
): {
  readonly terminalLabel: AnalystTerminalMapLabel;
  readonly accepted: boolean;
  readonly success: boolean;
  readonly successEligible: boolean;
  readonly noReceipt: boolean;
} {
  if (terminal.status === "absent") {
    return {
      terminalLabel: "no-receipt",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: true,
    };
  }

  const body = terminal.body;

  // Collector: typed groups array presence is the sole acceptance discriminator.
  if (role === "collector") {
    const groups = findCollectorGroups(body);
    if (Array.isArray(groups)) {
      return {
        terminalLabel: "groups",
        accepted: true,
        success: true,
        successEligible: true,
        noReceipt: false,
      };
    }
    return {
      terminalLabel: "non-accepted",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: false,
    };
  }

  const status = extractStatus(body);
  if (status === undefined) {
    return {
      terminalLabel: "non-accepted",
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: false,
    };
  }

  const acceptedSet = ACCEPTED_STATUS[role];
  if (acceptedSet === undefined || !acceptedSet.has(status)) {
    return {
      terminalLabel: status,
      accepted: false,
      success: false,
      successEligible: false,
      noReceipt: false,
    };
  }

  const plannedDuty = WORKER_ROLES.has(role) && status === "planned";
  const successSet = SUCCESS_STATUS[role] ?? new Set<string>();
  const success = !plannedDuty && successSet.has(status);
  const successEligible = !plannedDuty;

  return {
    terminalLabel: status,
    accepted: true,
    success,
    successEligible,
    noReceipt: false,
  };
}

function projectLegs(runs: readonly AnalystReadableRunFacts[]): AnalystAcceptanceLeg[] {
  // Order within lane+role by startedAt (then runId) to assign ordinals / rework.
  const sorted = [...runs].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    if (a.frameSpan.startedAt !== b.frameSpan.startedAt) {
      return a.frameSpan.startedAt.localeCompare(b.frameSpan.startedAt);
    }
    return a.runId.localeCompare(b.runId);
  });

  const ordinalByKey = new Map<string, number>();
  const legs: AnalystAcceptanceLeg[] = [];

  for (const run of sorted) {
    const key = `${run.book}\0${run.role}`;
    const ordinal = (ordinalByKey.get(key) ?? 0) + 1;
    ordinalByKey.set(key, ordinal);
    const mapped = mapTerminal(run.role, run.terminal);
    legs.push({
      runId: run.runId,
      book: run.book,
      role: run.role,
      startedAt: run.frameSpan.startedAt,
      wallMs: wallMsFromSpan(run.frameSpan),
      terminalLabel: mapped.terminalLabel,
      accepted: mapped.accepted,
      success: mapped.success,
      successEligible: mapped.successEligible,
      noReceipt: mapped.noReceipt,
      ordinalInLaneRole: ordinal,
      rework: ordinal >= 2,
    });
  }

  // Stable page order: book, role, runId (match A1 leg sort).
  return legs.sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.runId.localeCompare(b.runId);
  });
}

function aggregateByRole(legs: readonly AnalystAcceptanceLeg[]): AnalystRoleAcceptanceStats[] {
  const roles = [...new Set(legs.map((leg) => leg.role))].sort((a, b) => a.localeCompare(b));
  return roles.map((role) => {
    const roleLegs = legs.filter((leg) => leg.role === role);
    const acceptedCount = roleLegs.filter((leg) => leg.accepted).length;
    const successEligibleCount = roleLegs.filter((leg) => leg.successEligible).length;
    const successCount = roleLegs.filter((leg) => leg.success).length;
    const noReceiptCount = roleLegs.filter((leg) => leg.noReceipt).length;

    // Appearance lanes + first-pass: first call by startedAt within each book.
    const byBook = new Map<string, AnalystAcceptanceLeg[]>();
    for (const leg of roleLegs) {
      const list = byBook.get(leg.book) ?? [];
      list.push(leg);
      byBook.set(leg.book, list);
    }
    const books = [...byBook.keys()].sort((a, b) => a.localeCompare(b));
    const convergenceRounds: number[] = [];
    let firstPassLaneCount = 0;
    for (const book of books) {
      const laneLegs = [...byBook.get(book)!].sort((a, b) => {
        if (a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
        return a.runId.localeCompare(b.runId);
      });
      convergenceRounds.push(laneLegs.length);
      const first = laneLegs[0]!;
      if (first.accepted) firstPassLaneCount += 1;
    }
    const appearanceLaneCount = books.length;

    return {
      role,
      acceptedCount,
      successEligibleCount,
      successCount,
      noReceiptCount,
      successRate:
        successEligibleCount === 0 ? undefined : successCount / successEligibleCount,
      appearanceLaneCount,
      firstPassLaneCount,
      firstPassRate:
        appearanceLaneCount === 0 ? undefined : firstPassLaneCount / appearanceLaneCount,
      convergenceRounds,
      convergenceRoundsMedian: medianNumber(convergenceRounds),
    };
  });
}

function reworkLens(legs: readonly AnalystAcceptanceLeg[]): AnalystReworkLens {
  let reworkWallMs = 0;
  let totalWallMs = 0;
  let reworkLegCount = 0;
  for (const leg of legs) {
    totalWallMs += leg.wallMs;
    if (leg.rework) {
      reworkWallMs += leg.wallMs;
      reworkLegCount += 1;
    }
  }
  return {
    reworkWallMs,
    totalWallMs,
    reworkRatio: totalWallMs === 0 ? undefined : reworkWallMs / totalWallMs,
    reworkLegCount,
    totalLegCount: legs.length,
  };
}

export function buildAcceptanceSuccessReworkSection(
  runs: readonly AnalystReadableRunFacts[],
): AnalystAcceptanceSuccessReworkSection | undefined {
  if (runs.length === 0) return undefined;
  const legs = projectLegs(runs);
  return {
    kind: "analyst-acceptance-success-rework",
    legs,
    byRole: aggregateByRole(legs),
    rework: reworkLens(legs),
  };
}

const acceptanceSuccessReworkFamily: AnalystMetricFamilyModule = {
  id: "acceptance-success-rework",
  contribute(input) {
    const section = buildAcceptanceSuccessReworkSection(input.runs);
    if (section === undefined) return undefined;
    return { acceptanceSuccessRework: section };
  },
};

export default acceptanceSuccessReworkFamily;
