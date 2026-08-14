/**
 * Taishi issue metrics page envelope + atomic persistence (ADR 0068 / PRD #298).
 *
 * A1 minimum fields: issue scope (projectRoot) + leg list + unreadable exclusion.
 * A2: metric-family modules register optional top-level sections via the family
 * composition seam — B/C waves add family files without forking the page writer.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  physicalPathIdentity,
} from "./activation-ledger-topology.ts";
import type { TaishiReadableRunFacts } from "./taishi-ledger.ts";
import { TAISHI_ISSUE_METRIC_FAMILIES } from "./taishi-metric-families.ts";
import type { TaishiA2SeamProbeSection } from "./taishi-metric-family-a2-probe.ts";
import {
  composeTaishiMetricFamilySections,
  type TaishiMetricFamilyModule,
} from "./taishi-metric-family.ts";

/** Required run sources that may render a loud unreadable exclusion. */
export type TaishiMissingSource =
  | "session-timeline"
  | "tool-association"
  | "terminal-artifact";

export type TaishiUnreadableRun = {
  readonly runId: string;
  readonly book: string;
  readonly missingSources: readonly TaishiMissingSource[];
  readonly reason: string;
};

/** One readable in-scope leg (A1 identity only; metric families enrich via sections). */
export type TaishiLegEntry = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
};

/**
 * Per-issue typed metrics page.
 * Extension seam: metric-family modules add optional top-level sections
 * through TAISHI_ISSUE_METRIC_FAMILIES — keep this envelope stable.
 */
export type TaishiIssueMetricsPage = {
  readonly kind: "taishi-issue-metrics";
  readonly mode: "issue";
  readonly projectRoot: string;
  readonly legs: readonly TaishiLegEntry[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  readonly unreadableCount: number;
  /** A2 example family; absorbed/replaced when B1 lands. */
  readonly a2SeamProbe?: TaishiA2SeamProbeSection;
};

export function taishiIssuePageKey(projectRoot: string): string {
  const identity = physicalPathIdentity(projectRoot);
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

export function taishiIssuePagePath(ledgerHome: string, projectRoot: string): string {
  return join(ledgerHome, "taishi", "issues", `${taishiIssuePageKey(projectRoot)}.json`);
}

function sortLegs(legs: readonly TaishiLegEntry[]): TaishiLegEntry[] {
  return [...legs].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.runId.localeCompare(b.runId);
  });
}

function sortUnreadable(
  unreadable: readonly TaishiUnreadableRun[],
): TaishiUnreadableRun[] {
  return [...unreadable].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    return a.runId.localeCompare(b.runId);
  });
}

export function buildTaishiIssueMetricsPage(input: {
  readonly projectRoot: string;
  readonly runs: readonly TaishiReadableRunFacts[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  /** Override registry in tests; production uses TAISHI_ISSUE_METRIC_FAMILIES. */
  readonly families?: readonly TaishiMetricFamilyModule[];
}): TaishiIssueMetricsPage {
  const legs = sortLegs(
    input.runs.map((run) => ({
      runId: run.runId,
      book: run.book,
      role: run.role,
    })),
  );
  const unreadable = sortUnreadable(input.unreadable);
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const envelope = {
    kind: "taishi-issue-metrics" as const,
    mode: "issue" as const,
    projectRoot,
    legs,
    unreadable,
    unreadableCount: unreadable.length,
  };
  const families = input.families ?? TAISHI_ISSUE_METRIC_FAMILIES;
  const sections = composeTaishiMetricFamilySections(families, {
    projectRoot,
    runs: input.runs,
    unreadable,
  });
  return { ...envelope, ...sections };
}

/**
 * Atomically replace the issue metrics page (idempotent overwrite).
 * Directory creation and file placement go through the ledger home physical
 * containment owner (ADR 0038 / 0048) — never plain recursive mkdir alone.
 */
export async function writeTaishiIssueMetricsPage(
  ledgerHome: string,
  page: TaishiIssueMetricsPage,
): Promise<string> {
  const path = taishiIssuePagePath(ledgerHome, page.projectRoot);
  ensureRealDirectoryTree(ledgerHome, dirname(path));
  assertLedgerFileInsideHome(path, ledgerHome);
  await writeFileAtomically(path, `${JSON.stringify(page, null, 2)}\n`);
  return path;
}
