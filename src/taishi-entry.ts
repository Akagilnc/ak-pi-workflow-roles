/**
 * 太史 sole entry (ADR 0068 / PRD #298).
 * Deterministic analysis seat: read ledger records, write sibling metrics pages.
 * A1/A2: issue-mode typed input; C1 adds sweep mode on this same seam.
 * A2: scan retains typed per-run facts; page builder folds registered metric families.
 * C1: sweep = merged PR list + LOC → backfill issue pages + maintain library index.
 * C2: cohort = two issue-number groups → join library index → contrast query output.
 * C3: model-groups = caller issue set → scan union → per-leg model aggregate.
 * #338: retrieval compute-if-missing — sync wait for sole kernel, then full result.
 * Whole-compute failure is typed terminal for this pull (no pending envelope).
 * "Unobtrusive / non-blocking" binds #337 merge auto-trigger only, not user query.
 */
import { readFile } from "node:fs/promises";

import {
  errnoCode,
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
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
  taishiIssuePagePath,
  writeTaishiIssueMetricsPage,
  type TaishiIssueMetricsPage,
  type TaishiUnreadableRun,
} from "./taishi-page.ts";

/**
 * #338 compute-if-missing typed terminal failure (schema owner).
 * Public surface projects this object as-is — error code / issue / real cause
 * are typed fields, never prose cells for machine consumers.
 * Never wash into cohort/model-groups typed absent.
 */
export type TaishiIssueComputeFailure = {
  readonly code: "taishi-issue-compute-failed";
  readonly projectRoot: string;
  readonly issueNumber?: number;
  /** Real cause identity (errno / name when held) — no diagnostic prose cell. */
  readonly cause: {
    readonly code?: string;
    readonly name?: string;
  };
};

/**
 * #338 compute-if-missing failure — names the issue identity + real cause.
 * Sole schema owner for the public typed terminal failure face.
 */
export class TaishiIssueComputeError extends Error {
  readonly code = "taishi-issue-compute-failed" as const;
  readonly projectRoot: string;
  readonly issueNumber?: number;

  constructor(input: {
    readonly projectRoot: string;
    readonly issueNumber?: number;
    readonly cause: unknown;
  }) {
    const root = physicalPathIdentity(input.projectRoot);
    const causeText =
      input.cause instanceof Error
        ? input.cause.message || input.cause.name
        : String(input.cause);
    const issueFace =
      input.issueNumber === undefined
        ? `projectRoot ${root}`
        : `issue ${input.issueNumber} (projectRoot ${root})`;
    super(`taishi compute failed for ${issueFace}: ${causeText}`, {
      cause: input.cause,
    });
    this.name = "TaishiIssueComputeError";
    this.projectRoot = root;
    if (input.issueNumber !== undefined) {
      this.issueNumber = input.issueNumber;
    }
  }

  /** Canonical typed terminal failure object for public CLI / machine consumers. */
  toTypedFailure(): TaishiIssueComputeFailure {
    const rootCause = this.cause;
    const code = errnoCode(rootCause);
    const name = rootCause instanceof Error ? rootCause.name : undefined;
    return {
      code: this.code,
      projectRoot: this.projectRoot,
      ...(this.issueNumber === undefined ? {} : { issueNumber: this.issueNumber }),
      cause: {
        ...(code === undefined ? {} : { code }),
        ...(name === undefined ? {} : { name }),
      },
    };
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

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
   * Losing caller projectRoot when typed ticket/index root already won
   * (public CLI dual-param: --ticket index hit over concurrent --project-root).
   * When set and identity-distinct from projectRoot, page records the C4
   * typed-ticketNumber-over-projectRoot fact for this call — no ledger alien run required.
   */
  readonly conflictingProjectRoot?: string;
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

/**
 * #338 retrieval primitive (sync): use persisted page when present; otherwise
 * await the sole issue compute kernel (runTaishiIssueMode) which writes via the
 * existing page entry, then return the full result. No pending/async envelope.
 * Compute failures throw TaishiIssueComputeError (issue identity + real cause)
 * and terminate this pull — never washed to absent/partial success.
 * Single-run unreadable/damaged stays page-local exclusion (PRD #298), not a
 * whole-compute failure. Sweep / explicit recompute still use runTaishiIssueMode.
 */
export async function readOrComputeTaishiIssuePage(
  input: TaishiIssueModeInput,
): Promise<TaishiIssueModeResult> {
  const ledgerHome = resolveActivationLedgerHome();
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const pagePath = taishiIssuePagePath(ledgerHome, projectRoot);

  try {
    const raw = await readFile(pagePath, "utf8");
    const page = JSON.parse(raw) as TaishiIssueMetricsPage;
    return { mode: "issue", page, pagePath };
  } catch (error) {
    if (!isMissingPathError(error)) {
      // Corrupt / blocked page path — loud with issue identity, not absent.
      throw new TaishiIssueComputeError({
        projectRoot,
        ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
        cause: error,
      });
    }
  }

  try {
    return await runTaishiIssueMode(input);
  } catch (error) {
    if (error instanceof TaishiIssueComputeError) throw error;
    throw new TaishiIssueComputeError({
      projectRoot,
      ...(input.issueNumber === undefined ? {} : { issueNumber: input.issueNumber }),
      cause: error,
    });
  }
}

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
  const conflictingProjectRoot =
    "conflictingProjectRoot" in input ? input.conflictingProjectRoot : undefined;

  // Caller dual-param conflict (ticket/index root already won): record C4 fact
  // from the call faces themselves — independent of ledger alien runs.
  const scopeConflicts = [...scan.scopeConflicts];
  if (conflictingProjectRoot !== undefined && ticketNumber !== undefined) {
    const losingRoot = physicalPathIdentity(conflictingProjectRoot);
    const winningRoot = physicalPathIdentity(projectRoot);
    if (losingRoot !== winningRoot) {
      scopeConflicts.push({
        ticketNumber,
        projectRoot: losingRoot,
        fact: "typed-ticketNumber-over-projectRoot",
      });
    }
  }

  // Page build discovers metric families first — missing tree fails before write.
  const page = await buildTaishiIssueMetricsPage({
    projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
    scopeConflicts,
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

  // #338: ensure each scope root has a persisted issue page (compute-if-missing)
  // via the sole issue kernel + existing writer, then aggregate from live scan.
  for (const projectRoot of projectRoots) {
    await readOrComputeTaishiIssuePage({ mode: "issue", projectRoot });
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
 * - Cohort mode: join library index by issueNumber → ensure pages (#338) → contrast.
 * - Model-groups mode: issue-set scope → ensure pages (#338) → scan union → aggregate.
 * Metric-family kernels (B/C waves) drop a module under taishi-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — never an invocation field.
 * Retrieval compute-if-missing is readOrComputeTaishiIssuePage (not a second kernel).
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
    return runTaishiCohortMode(ledgerHome, input, async ({ projectRoot, issueNumber }) => {
      const ensured = await readOrComputeTaishiIssuePage({
        mode: "issue",
        projectRoot,
        issueNumber,
      });
      return ensured.page;
    });
  }
  if (input.mode === "model-groups") {
    return runTaishiModelGroupsMode(input);
  }
  return runTaishiIssueMode(input);
}
