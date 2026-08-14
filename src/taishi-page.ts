/**
 * Taishi issue metrics page envelope + atomic persistence (ADR 0068 / PRD #298).
 *
 * A1 minimum fields: issue scope (projectRoot) + leg list + unreadable exclusion.
 * Metric families (B1–B4 / C1–C3) compose additional optional sections via their
 * own modules onto this envelope — never by forking a second page writer.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { writeFileAtomically } from "./atomic-write.ts";
import {
  assertLedgerFileInsideHome,
  ensureRealDirectoryTree,
  physicalPathIdentity,
} from "./activation-ledger-topology.ts";

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

/** One readable in-scope leg (A1 identity only; metric families enrich later). */
export type TaishiLegEntry = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
};

/**
 * Per-issue typed metrics page.
 * Extension seam: metric-family modules may add optional top-level sections
 * in dedicated files; keep this envelope stable and composable.
 */
export type TaishiIssueMetricsPage = {
  readonly kind: "taishi-issue-metrics";
  readonly mode: "issue";
  readonly projectRoot: string;
  readonly legs: readonly TaishiLegEntry[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  readonly unreadableCount: number;
};

export function taishiIssuePageKey(projectRoot: string): string {
  const identity = physicalPathIdentity(projectRoot);
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

export function taishiIssuePagePath(ledgerHome: string, projectRoot: string): string {
  return join(ledgerHome, "taishi", "issues", `${taishiIssuePageKey(projectRoot)}.json`);
}

export function buildTaishiIssueMetricsPage(input: {
  readonly projectRoot: string;
  readonly legs: readonly TaishiLegEntry[];
  readonly unreadable: readonly TaishiUnreadableRun[];
}): TaishiIssueMetricsPage {
  const legs = [...input.legs].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.runId.localeCompare(b.runId);
  });
  const unreadable = [...input.unreadable].sort((a, b) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book);
    return a.runId.localeCompare(b.runId);
  });
  return {
    kind: "taishi-issue-metrics",
    mode: "issue",
    projectRoot: physicalPathIdentity(input.projectRoot),
    legs,
    unreadable,
    unreadableCount: unreadable.length,
  };
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
