/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1 accepts issue-mode typed input; C3 adds model-groups mode on this same seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
 */
import { physicalPathIdentity, resolveActivationLedgerHome } from "./activation-ledger-topology.ts";
import { scanTaishiIssueRuns } from "./taishi-ledger.ts";
import {
  buildTaishiModelGroupsPage,
  type TaishiModelGroupsPage,
} from "./taishi-model-groups.ts";
import {
  buildTaishiIssueMetricsPage,
  writeTaishiIssueMetricsPage,
  type TaishiIssueMetricsPage,
  type TaishiUnreadableRun,
} from "./taishi-page.ts";
import type { TaishiReadableRunFacts } from "./taishi-ledger.ts";

/** Issue-mode typed input — single-issue scope via projectRoot mechanical key. */
export type TaishiIssueModeInput = {
  readonly mode: "issue";
  readonly projectRoot: string;
};

/**
 * Model-groups mode typed input — caller-supplied issue set (+ optional alias map).
 * Scope is never guessed; empty projectRoots → empty groups.
 */
export type TaishiModelGroupsModeInput = {
  readonly mode: "model-groups";
  /** Issue set (projectRoot mechanical keys) defining the stats scope. */
  readonly projectRoots: readonly string[];
  /**
   * Optional combination mapping: raw group key → display alias only.
   * Must not merge groups or change denominators; unmapped keys keep raw name.
   */
  readonly combinationMapping?: Readonly<Record<string, string>>;
};

export type TaishiInput = TaishiIssueModeInput | TaishiModelGroupsModeInput;

export type TaishiIssueModeResult = {
  readonly mode: "issue";
  readonly page: TaishiIssueMetricsPage;
  readonly pagePath: string;
};

export type TaishiModelGroupsModeResult = {
  readonly mode: "model-groups";
  /** Query output — not persisted (PRD ④ is on-demand typed output). */
  readonly page: TaishiModelGroupsPage;
};

export type TaishiResult = TaishiIssueModeResult | TaishiModelGroupsModeResult;

async function runTaishiIssueMode(
  input: TaishiIssueModeInput,
): Promise<TaishiIssueModeResult> {
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

async function runTaishiModelGroupsMode(
  input: TaishiModelGroupsModeInput,
): Promise<TaishiModelGroupsModeResult> {
  // Resolve ledger home for side-effect-free topology readiness (scan uses it).
  resolveActivationLedgerHome();

  const runs: TaishiReadableRunFacts[] = [];
  const unreadable: TaishiUnreadableRun[] = [];
  // Dedupe scope roots by physical identity while preserving caller order for scan.
  const seen = new Set<string>();
  const projectRoots: string[] = [];
  for (const root of input.projectRoots) {
    const identity = physicalPathIdentity(root);
    if (seen.has(identity)) continue;
    seen.add(identity);
    projectRoots.push(identity);
  }

  for (const projectRoot of projectRoots) {
    const scan = await scanTaishiIssueRuns({ projectRoot });
    runs.push(...scan.runs);
    unreadable.push(...scan.unreadable);
  }

  // exactOptionalPropertyTypes: only pass mapping when caller supplied it.
  const page = input.combinationMapping === undefined
    ? buildTaishiModelGroupsPage({ projectRoots, runs, unreadable })
    : buildTaishiModelGroupsPage({
        projectRoots,
        runs,
        unreadable,
        combinationMapping: input.combinationMapping,
      });

  return { mode: "model-groups", page };
}

/**
 * Sole taishi entry.
 * - Issue mode: scope → scan (typed facts) → family compose → atomic replace.
 * - Model-groups mode: issue-set scope → scan union → per-leg model aggregate.
 * Metric-family kernels (B/C waves) drop a module under taishi-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 */
export async function runTaishi(input: TaishiIssueModeInput): Promise<TaishiIssueModeResult>;
export async function runTaishi(
  input: TaishiModelGroupsModeInput,
): Promise<TaishiModelGroupsModeResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult> {
  if (input.mode === "model-groups") {
    return runTaishiModelGroupsMode(input);
  }
  return runTaishiIssueMode(input);
}
