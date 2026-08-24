/**
 * Issue-mode metric-family registry (page composition point).
 *
 * B1–B4 families are statically imported so the public single-file bundle
 * (`dist/public-cli/main.js`) carries them. Dynamic directory discovery cannot
 * see sibling modules inside that bundle and must not be a second compute kernel.
 *
 * New issue-page families register by adding a static import + list entry here
 * (same loader seam; no parallel assembly path).
 */
import type { AnalystMetricFamilyModule } from "./analyst-metric-family.ts";
import acceptanceSuccessReworkFamily from "./analyst-metric-families/acceptance-success-rework.ts";
import b2FrameBucketsActionsFamily from "./analyst-metric-families/b2-frame-buckets-actions.ts";
import legWallClockFamily from "./analyst-metric-families/leg-wall-clock.ts";
import roundTimelineFamily from "./analyst-metric-families/round-timeline.ts";

/**
 * Production issue-page family modules in stable id order.
 * Static graph — reachable from source and from the public CLI bundle alike.
 */
const ISSUE_METRIC_FAMILIES: readonly AnalystMetricFamilyModule[] = [
  acceptanceSuccessReworkFamily,
  b2FrameBucketsActionsFamily,
  legWallClockFamily,
  roundTimelineFamily,
].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Load the registered issue-page metric families.
 * Always resolves the static package registry (never readdir of a sibling tree).
 */
export async function loadAnalystIssueMetricFamilies(): Promise<
  readonly AnalystMetricFamilyModule[]
> {
  return ISSUE_METRIC_FAMILIES;
}
