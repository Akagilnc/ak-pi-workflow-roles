/**
 * Taishi issue-page metric-family registration seam (A2).
 *
 * Each B/C-wave family owns one module file under taishi-metric-families/
 * and is listed in the static loader (taishi-metric-families.ts) so the
 * public single-file bundle carries every family. Families only contribute
 * optional page sections from typed run facts; they do not open a second
 * scan, entry, or page writer.
 */
import type { TaishiReadableRunFacts } from "./taishi-ledger.ts";
import type { TaishiUnreadableRun } from "./taishi-page.ts";

export type TaishiMetricFamilyInput = {
  readonly projectRoot: string;
  readonly runs: readonly TaishiReadableRunFacts[];
  readonly unreadable: readonly TaishiUnreadableRun[];
};

/** Optional top-level page sections contributed by one family module. */
export type TaishiMetricFamilyContribution = {
  readonly [sectionKey: string]: unknown;
};

export type TaishiMetricFamilyModule = {
  readonly id: string;
  contribute(input: TaishiMetricFamilyInput): TaishiMetricFamilyContribution | undefined;
};

/** Fold discovered family modules into one section bag (Object.assign order). */
export function composeTaishiMetricFamilySections(
  families: readonly TaishiMetricFamilyModule[],
  input: TaishiMetricFamilyInput,
): TaishiMetricFamilyContribution {
  const sections: Record<string, unknown> = {};
  for (const family of families) {
    const piece = family.contribute(input);
    if (piece === undefined) continue;
    Object.assign(sections, piece);
  }
  return sections;
}
