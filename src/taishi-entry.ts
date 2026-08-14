/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1/A2: issue-mode typed input; C1 adds sweep mode on this same seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
 * C1: sweep = merged PR list + LOC → backfill issue pages + maintain library index.
 */
import { resolveActivationLedgerHome } from "./activation-ledger-topology.ts";
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
   * C4: caller typed ticket face (#176). When set, issue 圈定 prefers matching
   * invocation.ticketNumber; runs without ticketNumber fall back to projectRoot.
   */
  readonly ticketNumber?: number;
  /**
   * 排除后改动行数 — optional caller typed input.
   * Omit or 0 → page retains typed 空缺 for LOC and 耗时/千行.
   */
  readonly changedLines?: number;
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

export type TaishiInput = TaishiIssueModeInput | TaishiSweepModeInput;

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

export type TaishiResult = TaishiIssueModeResult | TaishiSweepModeResult;

async function runTaishiIssueMode(
  input: TaishiIssueModeInput | TaishiMergedPullRequest,
): Promise<TaishiIssueModeResult> {
  const ledgerHome = resolveActivationLedgerHome();
  const projectRoot = input.projectRoot;
  // Sweep entries carry projectRoot only; issue mode may add ticketNumber (C4).
  const ticketNumber =
    "ticketNumber" in input ? input.ticketNumber : undefined;

  const scan = ticketNumber === undefined
    ? await scanTaishiIssueRuns({ projectRoot })
    : await scanTaishiIssueRuns({ projectRoot, ticketNumber });

  // exactOptionalPropertyTypes: only pass changedLines when caller supplied it.
  const pageBase = {
    projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
    scopeConflicts: scan.scopeConflicts,
  };
  const page = input.changedLines === undefined
    ? buildTaishiIssueMetricsPage(pageBase)
    : buildTaishiIssueMetricsPage({
        ...pageBase,
        changedLines: input.changedLines,
      });

  const pagePath = await writeTaishiIssueMetricsPage(ledgerHome, page);
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
 * - Sweep mode: for each merged PR entry run issue kernel, upsert library index.
 * Metric-family kernels (B/C waves) drop a module under taishi-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 */
export async function runTaishi(input: TaishiIssueModeInput): Promise<TaishiIssueModeResult>;
export async function runTaishi(input: TaishiSweepModeInput): Promise<TaishiSweepModeResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult> {
  if (input.mode === "sweep") {
    return runTaishiSweepMode(input);
  }
  return runTaishiIssueMode(input);
}
