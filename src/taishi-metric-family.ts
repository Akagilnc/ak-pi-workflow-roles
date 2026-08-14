/**
 * Taishi issue-page metric-family registration seam (A2).
 *
 * Each B/C-wave family owns one module file that implements this contract and
 * is listed in taishi-metric-families.ts. Families only contribute optional
 * page sections from typed run facts — they do not open a second scan, entry,
 * or page writer.
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

/**
 * Fold registered family modules into one section bag.
 * Duplicate section keys fail loudly — two families must not own the same key.
 */
export function composeTaishiMetricFamilySections(
  families: readonly TaishiMetricFamilyModule[],
  input: TaishiMetricFamilyInput,
): TaishiMetricFamilyContribution {
  const sections: Record<string, unknown> = {};
  for (const family of families) {
    const piece = family.contribute(input);
    if (piece === undefined) continue;
    for (const [key, value] of Object.entries(piece)) {
      if (Object.prototype.hasOwnProperty.call(sections, key)) {
        throw new Error(
          `taishi metric family section conflict: "${key}" (family ${family.id})`,
        );
      }
      sections[key] = value;
    }
  }
  return sections;
}
