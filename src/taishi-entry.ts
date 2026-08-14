/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1/A2: issue-mode typed input; C1 adds sweep mode on this same seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
 * C1: sweep = merged PR list + LOC → backfill issue pages + maintain library index.
 * C2: cohort = two issue-number groups → join library index → contrast query output.
 * C3: model-groups = caller issue set → scan union → per-leg model aggregate.
 */
import { physicalPathIdentity, resolveActivationLedgerHome } from "./activation-ledger-topology.ts";
import {
  runTaishiCohortMode,
  type TaishiCohortModeInput,
  type TaishiCohortModeResult,
} from "./taishi-cohort.ts";
import { scanTaishiIssueRuns, type TaishiReadableRunFacts } from "./taishi-ledger.ts";
import {
  readTaishiLibraryIndexPage,
  rowFromIssueMetricsPage,
  upsertTaishiLibraryIndexRows,
  writeTaishiLibraryIndexPage,
  type TaishiLibraryIndexPage,
} from "./taishi-index.ts";
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

export type TaishiInput =
  | TaishiIssueModeInput
  | TaishiSweepModeInput
  | TaishiCohortModeInput
  | TaishiModelGroupsModeInput;

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

export type TaishiModelGroupsModeResult = {
  readonly mode: "model-groups";
  /** Query output — not persisted (PRD ④ is on-demand typed output). */
  readonly page: TaishiModelGroupsPage;
};

export type TaishiResult =
  | TaishiIssueModeResult
  | TaishiSweepModeResult
  | TaishiCohortModeResult
  | TaishiModelGroupsModeResult;

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

  // exactOptionalPropertyTypes: only pass optional faces when caller supplied them.
  const issueNumber =
    "issueNumber" in input ? input.issueNumber : undefined;
  const page = buildTaishiIssueMetricsPage({
    projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
    scopeConflicts: scan.scopeConflicts,
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
 *   When issueNumber present, also upsert library index (C2 cohort join face).
 * - Sweep mode: for each merged PR entry run issue kernel, upsert library index.
 * - Cohort mode: join library index by issueNumber → fold present pages → contrast.
 * - Model-groups mode: issue-set scope → scan union → per-leg model aggregate.
 * Metric-family kernels (B/C waves) drop a module under taishi-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 */
export async function runTaishi(input: TaishiIssueModeInput): Promise<TaishiIssueModeResult>;
export async function runTaishi(input: TaishiSweepModeInput): Promise<TaishiSweepModeResult>;
export async function runTaishi(input: TaishiCohortModeInput): Promise<TaishiCohortModeResult>;
export async function runTaishi(
  input: TaishiModelGroupsModeInput,
): Promise<TaishiModelGroupsModeResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult>;
export async function runTaishi(input: TaishiInput): Promise<TaishiResult> {
  if (input.mode === "sweep") {
    return runTaishiSweepMode(input);
  }
  if (input.mode === "cohort") {
    const ledgerHome = resolveActivationLedgerHome();
    return runTaishiCohortMode(ledgerHome, input);
  }
  if (input.mode === "model-groups") {
    return runTaishiModelGroupsMode(input);
  }
  return runTaishiIssueMode(input);
}
