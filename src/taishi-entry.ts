/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1 accepts issue-mode typed input; C2 adds cohort contrast on this same seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
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
  buildTaishiIssueMetricsPage,
  writeTaishiIssueMetricsPage,
  type TaishiIssueMetricsPage,
} from "./taishi-page.ts";

/** Issue-mode typed input — single-issue scope via projectRoot mechanical key. */
export type TaishiIssueModeInput = {
  readonly mode: "issue";
  readonly projectRoot: string;
  /**
   * Caller typed issue number — retained on the metrics page for cohort index join.
   * Page addressing remains projectRoot (ADR 0068); issueNumber is not the key.
   */
  readonly issueNumber?: number;
};

export type TaishiInput = TaishiIssueModeInput | TaishiCohortModeInput;

export type TaishiIssueModeResult = {
  readonly mode: "issue";
  readonly page: TaishiIssueMetricsPage;
  readonly pagePath: string;
};

export type TaishiResult = TaishiIssueModeResult | TaishiCohortModeResult;

async function runTaishiIssueMode(
  input: TaishiIssueModeInput,
): Promise<TaishiIssueModeResult> {
  const ledgerHome = resolveActivationLedgerHome();

  const scan = await scanTaishiIssueRuns({
    projectRoot: input.projectRoot,
  });

  // exactOptionalPropertyTypes: only pass issueNumber when caller supplied it.
  const page = input.issueNumber === undefined
    ? buildTaishiIssueMetricsPage({
        projectRoot: input.projectRoot,
        runs: scan.runs,
        unreadable: scan.unreadable,
      })
    : buildTaishiIssueMetricsPage({
        projectRoot: input.projectRoot,
        runs: scan.runs,
        unreadable: scan.unreadable,
        issueNumber: input.issueNumber,
      });

  const pagePath = await writeTaishiIssueMetricsPage(ledgerHome, page);
  return { mode: "issue", page, pagePath };
}

/**
 * Sole taishi entry.
 * - Issue mode: scope → scan (typed facts) → family compose → atomic replace.
 * - Cohort mode: join library index by issueNumber → fold present pages → contrast.
 * Metric-family kernels (B/C waves) drop a module under taishi-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 */
export async function runTaishi(input: TaishiIssueModeInput): Promise<TaishiIssueModeResult>;
export async function runTaishi(input: TaishiCohortModeInput): Promise<TaishiCohortModeResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult> {
  if (input.mode === "cohort") {
    const ledgerHome = resolveActivationLedgerHome();
    return runTaishiCohortMode(ledgerHome, input);
  }
  return runTaishiIssueMode(input);
}
