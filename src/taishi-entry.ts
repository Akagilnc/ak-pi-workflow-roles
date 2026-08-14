/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1 accepts issue-mode typed input only; other modes compose later on this seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
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
};

export type TaishiInput = TaishiIssueModeInput;

export type TaishiIssueModeResult = {
  readonly mode: "issue";
  readonly page: TaishiIssueMetricsPage;
  readonly pagePath: string;
};

/**
 * Sole taishi entry. Issue mode: scope → scan (typed facts) → family compose → atomic replace.
 * Metric-family kernels (B/C waves) register via taishi-metric-families.ts and
 * consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 */
export async function runTaishi(input: TaishiInput): Promise<TaishiIssueModeResult> {
  // A1: issue mode only. Sweep/cohort/model modes join this same seam later.
  const ledgerHome = resolveActivationLedgerHome();

  const scan = await scanTaishiIssueRuns({
    projectRoot: input.projectRoot,
  });

  const page = buildTaishiIssueMetricsPage({
    projectRoot: input.projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
  });

  const pagePath = await writeTaishiIssueMetricsPage(ledgerHome, page);
  return { mode: "issue", page, pagePath };
}
