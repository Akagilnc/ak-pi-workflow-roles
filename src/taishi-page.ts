/**
 * Taishi issue metrics page envelope + atomic persistence (ADR 0068 / PRD #298).
 *
 * A1 minimum fields: issue scope (projectRoot) + leg list + unreadable exclusion.
 * A2: metric-family modules under taishi-metric-families/ contribute optional
 * top-level sections via directory discovery — B/C waves add family files
 * without forking the page writer or editing a shared registry list.
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
import { composeTaishiMetricFamilySections } from "./taishi-metric-family.ts";

/** Required run sources that may render a loud unreadable exclusion. */
export type TaishiMissingSource =
  | "session-timeline"
  | "tool-association"
  | "terminal-artifact";

/**
 * First usable session timestamp retained for an unreadable run when the
 * unique session/ledger owner obtained it before the loud failure.
 * Absent only when no usable timestamp was available — not a silent drop.
 */
export type TaishiFirstFrameAt =
  | { readonly status: "present"; readonly at: string }
  | { readonly status: "absent" };

export type TaishiUnreadableRun = {
  readonly runId: string;
  readonly book: string;
  readonly missingSources: readonly TaishiMissingSource[];
  readonly reason: string;
  /** Partial typed fact from A2 seam — B-wave projections sort/annotate from this. */
  readonly firstFrameAt: TaishiFirstFrameAt;
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
 * through directory discovery — keep this envelope stable.
 * issueNumber = caller typed field retained for cohort index join (ADR 0068
 * page key remains projectRoot; issueNumber is not the mechanical address).
 */
export type TaishiIssueMetricsPage = {
  readonly kind: "taishi-issue-metrics";
  readonly mode: "issue";
  readonly projectRoot: string;
  /** Caller typed issue number — present only when supplied on the entry. */
  readonly issueNumber?: number;
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
  /** Caller typed issue number — retained on page for cohort index join. */
  readonly issueNumber?: number;
}): TaishiIssueMetricsPage {
  // Sole run→leg projection owner: page envelope maps typed runs to A1 legs.
  const legs = sortLegs(
    input.runs.map((run) => ({
      runId: run.runId,
      book: run.book,
      role: run.role,
    })),
  );
  const unreadable = sortUnreadable(input.unreadable);
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const envelope: TaishiIssueMetricsPage = {
    kind: "taishi-issue-metrics" as const,
    mode: "issue" as const,
    projectRoot,
    // exactOptionalPropertyTypes: only materialize when caller supplied it.
    ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
    legs,
    unreadable,
    unreadableCount: unreadable.length,
  };
  const sections = composeTaishiMetricFamilySections(TAISHI_ISSUE_METRIC_FAMILIES, {
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
