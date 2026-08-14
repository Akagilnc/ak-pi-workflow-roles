/**
 * Taishi model-group mode kernel (PRD #298 output ④ / ticket #331).
 *
 * Per-leg raw model grouping (single | mixed:ordered-dedup whole-leg unit)
 * over a caller-typed issue set. Combination mapping is display-alias only:
 * raw group identity and denominators never merge.
 *
 * Acceptance / success faces reuse the B3 terminal map (受理≠成功, planned
 * out of success den) — no second outcome kernel.
 */
import { buildAcceptanceSuccessReworkSection } from "./taishi-metric-families/acceptance-success-rework.ts";
import type { TaishiReadableRunFacts } from "./taishi-ledger.ts";
import { medianNumber } from "./taishi-median.ts";
import type { TaishiUnreadableRun } from "./taishi-page.ts";

/** One raw model group with rates over legs in that group. */
export type TaishiModelGroupRow = {
  /** Stable raw identity (single model id, or `mixed:a+b` ordered-dedup). */
  readonly rawGroupKey: string;
  /** Display label after optional alias map; equals rawGroupKey when unmapped. */
  readonly displayName: string;
  readonly legCount: number;
  readonly acceptedCount: number;
  /** acceptedCount / legCount; undefined when legCount is 0. */
  readonly acceptanceRate: number | undefined;
  readonly successCount: number;
  /** Success-rate den (accepted ∧ ¬planned-duty), matching B3. */
  readonly successEligibleCount: number;
  /** successCount / successEligibleCount; undefined when den is 0. */
  readonly successRate: number | undefined;
  readonly noReceiptCount: number;
  /** noReceiptCount / legCount; undefined when legCount is 0. */
  readonly noReceiptRate: number | undefined;
  /** Leg wall-clock median (ms); even count → mean of two middles. */
  readonly wallClockMedianMs: number | undefined;
};

/** Typed model-group query output (not a persisted issue page). */
export type TaishiModelGroupsPage = {
  readonly kind: "taishi-model-groups";
  readonly mode: "model-groups";
  /** Caller-typed scope (physical identities), stable-sorted. */
  readonly projectRoots: readonly string[];
  readonly groups: readonly TaishiModelGroupRow[];
  /** Model-bearing legs only (sum of group dens); model-absent listed under unreadable. */
  readonly legCount: number;
  readonly unreadableCount: number;
  /** Scan damage + session-model vacancy (no empty-string group). */
  readonly unreadable: readonly TaishiUnreadableRun[];
};

/**
 * Build the raw group key for one leg from its ordered-unique model sequence.
 * Empty sequence → undefined (no inventable group; caller lists as typed vacancy).
 * One model → that raw id. Multi → `mixed:` + `+`-joined ordered uniques.
 */
export function taishiModelGroupKey(models: readonly string[]): string | undefined {
  if (models.length === 0) return undefined;
  if (models.length === 1) return models[0]!;
  return `mixed:${models.join("+")}`;
}

function rate(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return numerator / denominator;
}

function displayNameFor(
  rawGroupKey: string,
  combinationMapping: Readonly<Record<string, string>> | undefined,
): string {
  if (combinationMapping === undefined) return rawGroupKey;
  const aliased = combinationMapping[rawGroupKey];
  return aliased === undefined ? rawGroupKey : aliased;
}

function sortUnreadable(
  unreadable: readonly TaishiUnreadableRun[],
): TaishiUnreadableRun[] {
  return [...unreadable].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    return a.runId.localeCompare(b.runId);
  });
}

/**
 * Legs with no usable session model identity cannot join any model group.
 * Reuse the typed unreadable path (locatable missing-source) — not an empty-key group.
 */
function modelIdentityAbsentEntry(run: TaishiReadableRunFacts): TaishiUnreadableRun {
  return {
    runId: run.runId,
    book: run.book,
    missingSources: ["session-model"],
    reason: "session has no usable model identity",
    firstFrameAt: { status: "present", at: run.frameSpan.startedAt },
  };
}

/**
 * Aggregate readable runs into model groups.
 * Stats identity is always the raw key; mapping only projects displayName.
 * Model-identity vacancy is excluded from every group den and listed as unreadable.
 */
export function buildTaishiModelGroupsPage(input: {
  readonly projectRoots: readonly string[];
  readonly runs: readonly TaishiReadableRunFacts[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  readonly combinationMapping?: Readonly<Record<string, string>>;
}): TaishiModelGroupsPage {
  // Split before B3 projection: only model-bearing legs enter group dens.
  const groupedRuns: TaishiReadableRunFacts[] = [];
  const modelAbsent: TaishiUnreadableRun[] = [];
  for (const run of input.runs) {
    if (taishiModelGroupKey(run.models) === undefined) {
      modelAbsent.push(modelIdentityAbsentEntry(run));
    } else {
      groupedRuns.push(run);
    }
  }

  const acceptance = buildAcceptanceSuccessReworkSection(groupedRuns);
  const legByRunId = new Map(
    (acceptance?.legs ?? []).map((leg) => [leg.runId, leg] as const),
  );

  type Acc = {
    acceptedCount: number;
    successCount: number;
    successEligibleCount: number;
    noReceiptCount: number;
    walls: number[];
  };
  const byRaw = new Map<string, Acc>();

  for (const run of groupedRuns) {
    const rawGroupKey = taishiModelGroupKey(run.models);
    // groupedRuns is pre-filtered to model-bearing legs only.
    if (rawGroupKey === undefined) {
      throw new Error(
        `taishi model-groups: invariant — empty model key after filter for run ${run.runId}`,
      );
    }
    const leg = legByRunId.get(run.runId);
    if (leg === undefined) {
      // Readable run must project through B3 map; missing is an invariant break.
      throw new Error(
        `taishi model-groups: missing acceptance projection for run ${run.runId}`,
      );
    }
    let acc = byRaw.get(rawGroupKey);
    if (acc === undefined) {
      acc = {
        acceptedCount: 0,
        successCount: 0,
        successEligibleCount: 0,
        noReceiptCount: 0,
        walls: [],
      };
      byRaw.set(rawGroupKey, acc);
    }
    if (leg.accepted) acc.acceptedCount += 1;
    if (leg.success) acc.successCount += 1;
    if (leg.successEligible) acc.successEligibleCount += 1;
    if (leg.noReceipt) acc.noReceiptCount += 1;
    acc.walls.push(leg.wallMs);
  }

  const rawKeys = [...byRaw.keys()].sort((a, b) => a.localeCompare(b));
  const groups: TaishiModelGroupRow[] = rawKeys.map((rawGroupKey) => {
    const acc = byRaw.get(rawGroupKey)!;
    const legCount = acc.walls.length;
    return {
      rawGroupKey,
      displayName: displayNameFor(rawGroupKey, input.combinationMapping),
      legCount,
      acceptedCount: acc.acceptedCount,
      acceptanceRate: rate(acc.acceptedCount, legCount),
      successCount: acc.successCount,
      successEligibleCount: acc.successEligibleCount,
      successRate: rate(acc.successCount, acc.successEligibleCount),
      noReceiptCount: acc.noReceiptCount,
      noReceiptRate: rate(acc.noReceiptCount, legCount),
      wallClockMedianMs: medianNumber(acc.walls),
    };
  });

  const unreadable = sortUnreadable([...input.unreadable, ...modelAbsent]);

  return {
    kind: "taishi-model-groups",
    mode: "model-groups",
    projectRoots: [...input.projectRoots].sort((a, b) => a.localeCompare(b)),
    groups,
    legCount: groupedRuns.length,
    unreadableCount: unreadable.length,
    unreadable,
  };
}
