/**
 * Analyst issue-page metric-family registration seam (A2).
 *
 * Each B/C-wave family owns one module file under analyst-metric-families/
 * and is listed in the static loader (analyst-metric-families.ts) so the
 * public single-file bundle carries every family. Families only contribute
 * optional page sections from typed run facts; they do not open a second
 * scan, entry, or page writer.
 */
import type { AnalystReadableRunFacts } from "./analyst-ledger.ts";
import type { AnalystUnreadableRun } from "./analyst-page.ts";

export type AnalystMetricFamilyInput = {
  readonly projectRoot: string;
  readonly runs: readonly AnalystReadableRunFacts[];
  readonly unreadable: readonly AnalystUnreadableRun[];
};

/** Optional top-level page sections contributed by one family module. */
export type AnalystMetricFamilyContribution = {
  readonly [sectionKey: string]: unknown;
};

export type AnalystMetricFamilyModule = {
  readonly id: string;
  contribute(input: AnalystMetricFamilyInput): AnalystMetricFamilyContribution | undefined;
};

/** Fold discovered family modules into one section bag (Object.assign order). */
export function composeAnalystMetricFamilySections(
  families: readonly AnalystMetricFamilyModule[],
  input: AnalystMetricFamilyInput,
): AnalystMetricFamilyContribution {
  const sections: Record<string, unknown> = {};
  for (const family of families) {
    const piece = family.contribute(input);
    if (piece === undefined) continue;
    Object.assign(sections, piece);
  }
  return sections;
}
