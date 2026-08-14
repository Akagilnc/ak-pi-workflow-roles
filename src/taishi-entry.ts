/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1/A2: issue-mode typed input; C1 adds sweep mode on this same seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
 * C1: sweep = merged PR list + LOC → backfill issue pages + maintain library index.
 * C2: cohort = two issue-number groups → join library index → contrast query output.
 */
import { resolveActivationLedgerHome } from "./activation-ledger-topology.ts";
import {
  runTaishiCohortMode,
  type TaishiCohortModeInput,
  type TaishiCohortModeResult,
} from "./taishi-cohort.ts";
import { scanTaishiIssueRuns } from "./taishi-ledger.ts";
import {
  readTaishiLibraryIndexPage,
  rowFromIssueMetricsPage,
  upsertTaishiLibraryIndexRows,
  writeTaishiLibraryIndexPage,
  type TaishiLibraryIndexPage,
} from "./taishi-index.ts";
import {
  buildTaishiIssueMetricsPage,
  writeTaishiIssueMetricsPage,
  type TaishiIssueMetricsPage,
} from "./taishi-page.ts";

/** Issue-mode typed input — single-issue scope via projectRoot mechanical key. */
export type TaishiIssueModeInput = {
  readonly mode: "issue";
  readonly projectRoot: string;
  /**
   * 排除后改动行数 — optional caller typed input.
   * Omit or 0 → page retains typed 空缺 for LOC and 耗时/千行.
   */
  readonly changedLines?: number;
  /**
   * Caller typed issue number — retained on the metrics page for cohort index join.
   * Page addressing remains projectRoot (ADR 0068); issueNumber is not the key.
   * When present, issue mode also maintains the unique issueNumber→projectRoot index row.
   */
  readonly issueNumber?: number;
};

/** One merged-PR / issue entry for sweep-mode typed input. */
export type TaishiMergedPullRequest = {
  readonly projectRoot: string;
  /**
   * 排除后改动行数 — caller typed; omit or 0 → typed 空缺.
   * Sweep always carries the LOC face (present or absent) per issue.
   */
  readonly changedLines?: number;
};

/** Sweep-mode typed input — 已并 PR 清单 + LOC → 补算缺页 + 维护全库索引. */
export type TaishiSweepModeInput = {
  readonly mode: "sweep";
  readonly mergedPullRequests: readonly TaishiMergedPullRequest[];
};

export type TaishiInput =
  | TaishiIssueModeInput
  | TaishiSweepModeInput
  | TaishiCohortModeInput;

export type TaishiIssueModeResult = {
  readonly mode: "issue";
  readonly page: TaishiIssueMetricsPage;
  readonly pagePath: string;
};

export type TaishiSweepModeResult = {
  readonly mode: "sweep";
  /** Per-issue page results in input order (duplicates collapse on disk by key). */
  readonly issuePages: readonly TaishiIssueModeResult[];
  readonly index: TaishiLibraryIndexPage;
  readonly indexPath: string;
};

export type TaishiResult =
  | TaishiIssueModeResult
  | TaishiSweepModeResult
  | TaishiCohortModeResult;

async function runTaishiIssueMode(
  input: TaishiIssueModeInput | TaishiMergedPullRequest,
): Promise<TaishiIssueModeResult> {
  const ledgerHome = resolveActivationLedgerHome();
  const projectRoot = input.projectRoot;

  const scan = await scanTaishiIssueRuns({ projectRoot });

  // exactOptionalPropertyTypes: only pass optional faces when caller supplied them.
  const issueNumber =
    "issueNumber" in input ? input.issueNumber : undefined;
  const page = buildTaishiIssueMetricsPage({
    projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
    ...(input.changedLines === undefined ? {} : { changedLines: input.changedLines }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
  });

  const pagePath = await writeTaishiIssueMetricsPage(ledgerHome, page);

  // Issue number present → maintain the unique issueNumber→projectRoot index row
  // so cohort can join without a second addressing kernel (ADR 0068 page key unchanged).
  // Row carries C1 efficiency columns from the page (single index shape, no second kernel).
  if (issueNumber !== undefined) {
    const existing = await readTaishiLibraryIndexPage(ledgerHome);
    const index = upsertTaishiLibraryIndexRows(existing, [
      rowFromIssueMetricsPage(page),
    ]);
    await writeTaishiLibraryIndexPage(ledgerHome, index);
  }

  return { mode: "issue", page, pagePath };
}

async function runTaishiSweepMode(
  input: TaishiSweepModeInput,
): Promise<TaishiSweepModeResult> {
  const ledgerHome = resolveActivationLedgerHome();

  const issuePages: TaishiIssueModeResult[] = [];
  for (const entry of input.mergedPullRequests) {
    issuePages.push(await runTaishiIssueMode(entry));
  }

  const existing = await readTaishiLibraryIndexPage(ledgerHome);
  const upserts = issuePages.map((result) => rowFromIssueMetricsPage(result.page));
  const index = upsertTaishiLibraryIndexRows(existing, upserts);
  const indexPath = await writeTaishiLibraryIndexPage(ledgerHome, index);

  return { mode: "sweep", issuePages, index, indexPath };
}

/**
 * Sole taishi entry.
 * - Issue mode: scope → scan (typed facts) → family compose → atomic replace.
 *   When issueNumber present, also upsert library index (C2 cohort join face).
 * - Sweep mode: for each merged PR entry run issue kernel, upsert library index.
 * - Cohort mode: join library index by issueNumber → fold present pages → contrast.
 * Metric-family kernels (B/C waves) drop a module under taishi-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 */
export async function runTaishi(input: TaishiIssueModeInput): Promise<TaishiIssueModeResult>;
export async function runTaishi(input: TaishiSweepModeInput): Promise<TaishiSweepModeResult>;
export async function runTaishi(input: TaishiCohortModeInput): Promise<TaishiCohortModeResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult> {
  if (input.mode === "sweep") {
    return runTaishiSweepMode(input);
  }
  if (input.mode === "cohort") {
    const ledgerHome = resolveActivationLedgerHome();
    return runTaishiCohortMode(ledgerHome, input);
  }
  return runTaishiIssueMode(input);
}
