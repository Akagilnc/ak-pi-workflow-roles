/**
 * Issue-mode metric-family registry (page composition point).
 *
 * B/C-wave slices add their own family module file and one registration line
 * here — they do not modify taishi-entry / taishi-ledger / page envelope skeleton.
 */
import { a2SeamProbeFamily } from "./taishi-metric-family-a2-probe.ts";
import type { TaishiMetricFamilyModule } from "./taishi-metric-family.ts";

export const TAISHI_ISSUE_METRIC_FAMILIES: readonly TaishiMetricFamilyModule[] = [
  a2SeamProbeFamily,
];
