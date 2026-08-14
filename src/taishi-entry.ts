/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1 accepts issue-mode typed input only; other modes compose later on this seam.
 */
import { resolveActivationLedgerHome } from "./activation-ledger-topology.ts";
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
   * Machine-home identity for tests/fixtures.
   * Not a record destination — ledger topology alone computes page paths.
   */
  readonly home?: string;
};

export type TaishiInput = TaishiIssueModeInput;

export type TaishiIssueModeResult = {
  readonly mode: "issue";
  readonly page: TaishiIssueMetricsPage;
  readonly pagePath: string;
};

/**
 * Sole taishi entry. Issue mode: scope → scan → page envelope → atomic replace.
 * Metric-family kernels (B/C waves) will enrich the page via dedicated modules
 * without opening a second entry or second parse kernel.
 */
export async function runTaishi(input: TaishiInput): Promise<TaishiIssueModeResult> {
  // A1: issue mode only. Sweep/cohort/model modes join this same seam later.
  const ledgerHome = resolveActivationLedgerHome(
    input.home === undefined ? undefined : () => input.home!,
  );

  const scan = await scanTaishiIssueRuns({
    projectRoot: input.projectRoot,
    ...(input.home === undefined ? {} : { home: input.home }),
  });

  const page = buildTaishiIssueMetricsPage({
    projectRoot: input.projectRoot,
    legs: scan.legs,
    unreadable: scan.unreadable,
  });

  const pagePath = await writeTaishiIssueMetricsPage(ledgerHome, page);
  return { mode: "issue", page, pagePath };
}
