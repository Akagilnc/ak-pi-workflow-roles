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
import { Type, type Static } from "typebox";

import { physicalPathIdentity, resolveActivationLedgerHome } from "./activation-ledger-topology.ts";
import { isSyntheticAnalystBookKey, resolveAnalystBookKey } from "./analyst-book-key.ts";
import {
  runAnalystCohortMode,
  type AnalystCohortModeInput,
  type AnalystCohortModeResult,
} from "./analyst-cohort.ts";
import {
  scanAnalystIssueRuns,
  type AnalystReadableRunFacts,
  type AnalystScopedRunScan,
} from "./analyst-ledger.ts";
import {
  mergeAnalystLibraryIndexRows,
  rowFromIssueMetricsPage,
  type AnalystLibraryIndexPage,
} from "./analyst-index.ts";
import {
  buildAnalystModelGroupsPage,
  type AnalystModelGroupsPage,
} from "./analyst-model-groups.ts";
import {
  assertAnalystChangedLinesInput,
  buildAnalystIssueMetricsPage,
  analystIssuePagePath,
  writeAnalystIssueMetricsPage,
  type AnalystIssueMetricsPage,
  type AnalystUnreadableRun,
} from "./analyst-page.ts";

/** #338 compute-if-missing failure — issue identity + real cause (CLI → ControlledFailure). */
export class AnalystIssueComputeError extends Error {
  readonly code = "analyst-issue-compute-failed" as const;
  readonly bookKey: string;
  readonly projectRoot: string;
  readonly issueNumber?: number;

  constructor(input: {
    readonly bookKey: string;
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
        ? `book ${input.bookKey} (projectRoot ${root})`
        : `issue ${input.issueNumber} book ${input.bookKey} (projectRoot ${root})`;
    super(`analyst compute failed for ${issueFace}: ${causeText}`, {
      cause: input.cause,
    });
    this.name = "AnalystIssueComputeError";
    this.bookKey = input.bookKey;
    this.projectRoot = root;
    if (input.issueNumber !== undefined) {
      this.issueNumber = input.issueNumber;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Issue-mode typed input — book × ticket scope (#399). */
export type AnalystIssueModeInput = {
  readonly mode: "issue";
  /**
   * Ledger book identity (git common-dir key). Required for CLI issue query.
   * When omitted, sweep/legacy may supply projectRoot alone (path-narrow / git resolve).
   */
  readonly bookKey?: string;
  /**
   * Recording/display face and sweep/legacy path-narrow pointer.
   * Not the CLI issue-query mechanical key after #399 (ADR 0068 revised).
   */
  readonly projectRoot: string;
  /**
   * C4/#399: caller typed ticket face (#176). When set, issue 圈定 admits only
   * matching invocation.ticketNumber — no silent projectRoot fallback.
   */
  readonly ticketNumber?: number;
  /**
   * 排除后改动行数 — optional caller typed input.
   * Omit or 0 → page retains typed 空缺 for LOC and 耗时/千行.
   */
  readonly changedLines?: number;
  /**
   * Caller typed issue number — retained on the metrics page for cohort index join.
   * Page address = book + ticket when present (#399); not a global bare number key.
   * When present, issue mode also maintains the library-index row (cohort consumer).
   */
  readonly issueNumber?: number;
};

/**
 * Sole sweep-mode input contract (#298/#329/#337).
 * Schema is the single definition; TS types are derived (no parallel hand shape).
 * projectRoot = string (not nonempty); changedLines optional finite non-negative;
 * 0 remains typed 空缺; no extra keys.
 */
export const analystSweepModeInputSchema = Type.Object(
  {
    mode: Type.Literal("sweep"),
    mergedPullRequests: Type.Array(
      Type.Object(
        {
          projectRoot: Type.String(),
          /** 排除后改动行数 — omit or 0 → typed 空缺; finite ≥ 0 only. */
          changedLines: Type.Optional(
            Type.Number({ minimum: 0, maximum: Number.MAX_VALUE }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Sweep-mode typed input — 已并 PR 清单 + LOC → 补算缺页 + 维护全库索引. */
export type AnalystSweepModeInput = Static<typeof analystSweepModeInputSchema>;

/** One merged-PR / issue entry for sweep-mode typed input. */
export type AnalystMergedPullRequest =
  AnalystSweepModeInput["mergedPullRequests"][number];

/**
 * Model-groups mode typed input — caller-supplied issue set (+ optional alias map).
 * Scope is never guessed; empty projectRoots → empty groups.
 */
export type AnalystModelGroupsModeInput = {
  readonly mode: "model-groups";
  /** Issue set (projectRoot mechanical keys) defining the stats scope. */
  readonly projectRoots: readonly string[];
  /**
   * Optional combination mapping: raw group key → display alias only.
   * Must not merge groups or change denominators; unmapped keys keep raw name.
   */
  readonly combinationMapping?: Readonly<Record<string, string>>;
};

export type AnalystInput =
  | AnalystIssueModeInput
  | AnalystSweepModeInput
  | AnalystCohortModeInput
  | AnalystModelGroupsModeInput;

export type AnalystIssueModeResult = {
  readonly mode: "issue";
  readonly page: AnalystIssueMetricsPage;
  readonly pagePath: string;
};

export type AnalystSweepModeResult = {
  readonly mode: "sweep";
  /** Per-issue page results in input order (duplicates collapse on disk by key). */
  readonly issuePages: readonly AnalystIssueModeResult[];
  readonly index: AnalystLibraryIndexPage;
  readonly indexPath: string;
};

export type AnalystModelGroupsModeResult = {
  readonly mode: "model-groups";
  /** Query output — not persisted (PRD ④ is on-demand typed output). */
  readonly page: AnalystModelGroupsPage;
};

export type AnalystResult =
  | AnalystIssueModeResult
  | AnalystSweepModeResult
  | AnalystCohortModeResult
  | AnalystModelGroupsModeResult;

/**
 * #338 retrieval primitive (sync): use persisted page when present; otherwise
 * await the sole issue compute kernel (runAnalystIssueMode) which writes via the
 * existing page entry, then return the full result. No pending/async envelope.
 * Compute failures throw AnalystIssueComputeError (issue identity + real cause)
 * and terminate this pull — never washed to absent/partial success.
 * Single-run unreadable/damaged stays page-local exclusion (PRD #298), not a
 * whole-compute failure. Sweep / explicit recompute still use runAnalystIssueMode.
 */
/**
 * Cached page may be reused only under bidirectional book×ticket scope equality.
 * - requested ticket present: page.issueNumber must equal it and bookKey matches
 * - requested ticket absent: only reuse a page that also lacks issueNumber
 *   (a narrower ticket page must not stand in for the full book page)
 */
function cachedPageMatchesRequestedScope(
  page: AnalystIssueMetricsPage,
  input: { readonly bookKey: string; readonly issueNumber?: number; readonly ticketNumber?: number },
): boolean {
  if (page.bookKey !== input.bookKey) return false;
  const requestedTicket = input.ticketNumber ?? input.issueNumber;
  if (requestedTicket === undefined) {
    return page.issueNumber === undefined;
  }
  return page.issueNumber === requestedTicket;
}

/**
 * Resolve page/scan book identity for issue mode (#399).
 * CLI supplies bookKey from cwd git common-dir.
 * Sweep/legacy without bookKey falls back to the single shared
 * projectRoot→bookKey rule (git common-dir, else `root:<identity>`).
 */
function resolveIssueBookKey(input: {
  readonly bookKey?: string;
  readonly projectRoot: string;
}): string {
  if (input.bookKey !== undefined && input.bookKey.trim() !== "") {
    return input.bookKey;
  }
  return resolveAnalystBookKey(input.projectRoot);
}

export async function readOrComputeAnalystIssuePage(
  input: AnalystIssueModeInput,
  /**
   * Cohort ensure only (#412): narrow the cache-miss recompute scan to this
   * root inside the already-selected book — a miss must never widen to a
   * whole-book scan for one index row. Not a public CLI face.
   */
  options?: { readonly scanProjectRoot?: string; readonly home?: string },
): Promise<AnalystIssueModeResult> {
  const ledgerHome = resolveActivationLedgerHome(
    options?.home === undefined ? undefined : () => options.home,
  );
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const bookKey = resolveIssueBookKey(input);
  const issueNumber = input.ticketNumber ?? input.issueNumber;
  const pagePath = analystIssuePagePath(ledgerHome, {
    bookKey,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    // Sweep/legacy path-narrow pages (no ticket, no explicit CLI book-only scope).
    ...(issueNumber === undefined && input.bookKey === undefined
      ? { scopeRootIdentity: projectRoot }
      : {}),
  });

  try {
    const raw = await readFile(pagePath, "utf8");
    const page = JSON.parse(raw) as AnalystIssueMetricsPage;
    if (cachedPageMatchesRequestedScope(page, { bookKey, ...input })) {
      return { mode: "issue", page, pagePath };
    }
    // Existing page is for a different / absent ticket scope — same kernel recompute.
  } catch (error) {
    if (!isMissingPathError(error)) {
      // Corrupt / blocked page path — loud with issue identity, not absent.
      throw new AnalystIssueComputeError({
        bookKey,
        projectRoot,
        ...(issueNumber === undefined ? {} : { issueNumber }),
        cause: error,
      });
    }
  }

  try {
    return await runAnalystIssueMode(input, undefined, options?.scanProjectRoot, options?.home);
  } catch (error) {
    if (error instanceof AnalystIssueComputeError) throw error;
    throw new AnalystIssueComputeError({
      bookKey,
      projectRoot,
      ...(issueNumber === undefined ? {} : { issueNumber }),
      cause: error,
    });
  }
}

async function runAnalystIssueMode(
  input: AnalystIssueModeInput | AnalystMergedPullRequest,
  /** Caller-supplied scan facts — skip a second ledger walk when already scanned. */
  precomputedScan?: AnalystScopedRunScan,
  /** Cohort ensure conjunction (#412): scan this root inside the selected book. */
  scanProjectRoot?: string,
  home?: string,
): Promise<AnalystIssueModeResult> {
  // Programmatic issue/sweep entry boundary — same finite non-negative rule as attach schema.
  assertAnalystChangedLinesInput(input.changedLines);
  const ledgerHome = resolveActivationLedgerHome(
    home === undefined ? undefined : () => home,
  );
  const projectRoot = input.projectRoot;
  // Sweep entries carry projectRoot only; issue mode may add ticketNumber (C4).
  const ticketNumber =
    "ticketNumber" in input ? input.ticketNumber : undefined;
  const inputBookKey =
    "bookKey" in input && typeof input.bookKey === "string" && input.bookKey.trim() !== ""
      ? input.bookKey
      : undefined;

  const scan = precomputedScan ??
    (inputBookKey !== undefined
      ? await scanAnalystIssueRuns({
          bookKey: inputBookKey,
          ...(scanProjectRoot === undefined ? {} : { projectRoot: scanProjectRoot }),
          ...(ticketNumber === undefined ? {} : { ticketNumber }),
          ...(home === undefined ? {} : { home }),
        })
      : ticketNumber === undefined
      ? await scanAnalystIssueRuns({ projectRoot, ...(home === undefined ? {} : { home }) })
      : await scanAnalystIssueRuns({ projectRoot, ticketNumber, ...(home === undefined ? {} : { home }) }));

  // exactOptionalPropertyTypes: only pass optional faces when caller supplied them.
  const issueNumber =
    "issueNumber" in input ? input.issueNumber : undefined;

  const bookKey = resolveIssueBookKey({
    ...(inputBookKey === undefined ? {} : { bookKey: inputBookKey }),
    projectRoot,
  });

  // CLI book/ticket pages: no scopeRootIdentity.
  // Sweep/legacy path-narrow (no explicit bookKey, no ticket): address includes root.
  const scopeRootIdentity =
    inputBookKey === undefined && ticketNumber === undefined && issueNumber === undefined
      ? physicalPathIdentity(projectRoot)
      : undefined;

  // Page build discovers metric families first — missing tree fails before write.
  const page = await buildAnalystIssueMetricsPage({
    bookKey,
    projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
    scopeConflicts: scan.scopeConflicts,
    ...(input.changedLines === undefined ? {} : { changedLines: input.changedLines }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(scopeRootIdentity === undefined ? {} : { scopeRootIdentity }),
  });

  const pagePath = await writeAnalystIssueMetricsPage(ledgerHome, page);

  // Issue number present → maintain library-index row for cohort join (sole remaining
  // consumer of the index; ticket CLI path never reads it — #399 D9).
  // Row carries bookKey so cross-book same ticket numbers do not merge (D5).
  // Locked read→upsert→write so concurrent issue/sweep CLI writers do not drop rows.
  if (issueNumber !== undefined) {
    await mergeAnalystLibraryIndexRows(ledgerHome, [
      rowFromIssueMetricsPage(page),
    ]);
  }

  return { mode: "issue", page, pagePath };
}

async function runAnalystSweepMode(
  input: AnalystSweepModeInput,
  home?: string,
): Promise<AnalystSweepModeResult> {
  const ledgerHome = resolveActivationLedgerHome(
    home === undefined ? undefined : () => home,
  );

  const issuePages: AnalystIssueModeResult[] = [];
  for (const entry of input.mergedPullRequests) {
    issuePages.push(await runAnalystIssueMode(entry, undefined, undefined, home));
  }

  const upserts = issuePages.map((result) => rowFromIssueMetricsPage(result.page));
  const { index, indexPath } = await mergeAnalystLibraryIndexRows(ledgerHome, upserts);

  return { mode: "sweep", issuePages, index, indexPath };
}

async function runAnalystModelGroupsMode(
  input: AnalystModelGroupsModeInput,
  home?: string,
): Promise<AnalystModelGroupsModeResult> {
  const ledgerHome = resolveActivationLedgerHome(
    home === undefined ? undefined : () => home,
  );

  const runs: AnalystReadableRunFacts[] = [];
  const unreadable: AnalystUnreadableRun[] = [];
  // Dedupe scope roots by physical identity while preserving caller order for scan.
  const seen = new Set<string>();
  const projectRoots: string[] = [];
  for (const root of input.projectRoots) {
    const identity = physicalPathIdentity(root);
    if (seen.has(identity)) continue;
    seen.add(identity);
    projectRoots.push(identity);
  }

  // One ledger scan per root — shared by #338 ensure-page and model-group aggregate.
  // No second scan pass; sole issue kernel + existing writer when page is missing.
  for (const projectRoot of projectRoots) {
    const scan = await scanAnalystIssueRuns({ projectRoot, ...(home === undefined ? {} : { home }) });
    runs.push(...scan.runs);
    unreadable.push(...scan.unreadable);

    const bookKey = resolveIssueBookKey({ projectRoot });
    const pagePath = analystIssuePagePath(ledgerHome, {
      bookKey,
      scopeRootIdentity: projectRoot,
    });
    try {
      const raw = await readFile(pagePath, "utf8");
      JSON.parse(raw); // present page must parse (same loud face as readOrCompute)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new AnalystIssueComputeError({ bookKey, projectRoot, cause: error });
      }
      try {
        // Reuse this root's scan facts — no second ledger walk on compute-if-missing.
        await runAnalystIssueMode({ mode: "issue", projectRoot }, scan, undefined, home);
      } catch (computeError) {
        if (computeError instanceof AnalystIssueComputeError) throw computeError;
        throw new AnalystIssueComputeError({ bookKey, projectRoot, cause: computeError });
      }
    }
  }

  // exactOptionalPropertyTypes: only pass mapping when caller supplied it.
  const page = input.combinationMapping === undefined
    ? buildAnalystModelGroupsPage({ projectRoots, runs, unreadable })
    : buildAnalystModelGroupsPage({
        projectRoots,
        runs,
        unreadable,
        combinationMapping: input.combinationMapping,
      });

  return { mode: "model-groups", page };
}

/**
 * Sole analyst entry.
 * - Issue mode: scope → scan (typed facts) → family compose → atomic replace.
 *   When issueNumber present, also upsert library index (C2 cohort join face).
 * - Sweep mode: for each merged PR entry run issue kernel, upsert library index.
 * - Cohort mode: join library index by issueNumber → ensure pages (#338) → contrast.
 * - Model-groups mode: issue-set scope → one scan/root (ensure page #338 + aggregate).
 * Metric-family kernels (B/C waves) drop a module under analyst-metric-families/
 * and consume scan facts without opening a second entry or second parse kernel.
 * Machine home is package-owned (ADR 0048) — caller may pass explicit home option for isolation.
 * Retrieval compute-if-missing is readOrComputeAnalystIssuePage (not a second kernel).
 */
export async function runAnalyst(
  input: AnalystIssueModeInput,
  options?: { readonly home?: string },
): Promise<AnalystIssueModeResult>;
export async function runAnalyst(
  input: AnalystSweepModeInput,
  options?: { readonly home?: string },
): Promise<AnalystSweepModeResult>;
export async function runAnalyst(
  input: AnalystCohortModeInput,
  options?: { readonly home?: string },
): Promise<AnalystCohortModeResult>;
export async function runAnalyst(
  input: AnalystModelGroupsModeInput,
  options?: { readonly home?: string },
): Promise<AnalystModelGroupsModeResult>;
export async function runAnalyst(
  input: AnalystInput,
  options?: { readonly home?: string },
): Promise<AnalystResult>;
export async function runAnalyst(
  input: AnalystInput,
  options?: { readonly home?: string },
): Promise<AnalystResult> {
  if (input.mode === "sweep") {
    return runAnalystSweepMode(input, options?.home);
  }
  if (input.mode === "cohort") {
    const ledgerHome = resolveActivationLedgerHome(
      options?.home === undefined ? undefined : () => options.home,
    );
    return runAnalystCohortMode(ledgerHome, input, async ({ projectRoot, issueNumber, bookKey }) => {
      // Real ledger book keys drive book scope. Only `root:` + an absolute path
      // is a synthetic sweep/legacy address key; a real book basename may be
      // literally `root:foo` and must keep its book scope (U3, non-ambiguous
      // bidirectional check — never a bare prefix test).
      const realBookKey =
        bookKey !== undefined && !isSyntheticAnalystBookKey(bookKey)
          ? bookKey
          : undefined;
      // T4 revised (#413 r2 U2 owner decision, per #399 book×ticket identity):
      // cohort issueNumber IS the ticketNumber. A cache-miss recompute filters
      // by bookKey ∧ projectRoot ∧ invocation.ticketNumber; legacy runs without
      // a typed ticket are excluded from the recompute — never merged into the
      // issue page by path alone.
      const ensured = await readOrComputeAnalystIssuePage({
        mode: "issue",
        projectRoot,
        issueNumber,
        ticketNumber: issueNumber,
        ...(realBookKey === undefined ? {} : { bookKey: realBookKey }),
      }, { scanProjectRoot: projectRoot, ...(options?.home === undefined ? {} : { home: options.home }) });
      return ensured.page;
    });
  }
  if (input.mode === "model-groups") {
    return runAnalystModelGroupsMode(input, options?.home);
  }
  return runAnalystIssueMode(input, undefined, undefined, options?.home);
}
