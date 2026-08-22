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
import { resolveTaishiBookKey } from "./taishi-book-key.ts";
import {
  runTaishiCohortMode,
  type TaishiCohortModeInput,
  type TaishiCohortModeResult,
} from "./taishi-cohort.ts";
import {
  scanTaishiIssueRuns,
  type TaishiReadableRunFacts,
  type TaishiScopedRunScan,
} from "./taishi-ledger.ts";
import {
  mergeTaishiLibraryIndexRows,
  rowFromIssueMetricsPage,
  type TaishiLibraryIndexPage,
} from "./taishi-index.ts";
import {
  buildTaishiModelGroupsPage,
  type TaishiModelGroupsPage,
} from "./taishi-model-groups.ts";
import {
  assertTaishiChangedLinesInput,
  buildTaishiIssueMetricsPage,
  taishiIssuePagePath,
  writeTaishiIssueMetricsPage,
  type TaishiIssueMetricsPage,
  type TaishiUnreadableRun,
} from "./taishi-page.ts";

/** #338 compute-if-missing failure — issue identity + real cause (CLI → ControlledFailure). */
export class TaishiIssueComputeError extends Error {
  readonly code = "taishi-issue-compute-failed" as const;
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
    super(`taishi compute failed for ${issueFace}: ${causeText}`, {
      cause: input.cause,
    });
    this.name = "TaishiIssueComputeError";
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
export type TaishiIssueModeInput = {
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
export const taishiSweepModeInputSchema = Type.Object(
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
export type TaishiSweepModeInput = Static<typeof taishiSweepModeInputSchema>;

/** One merged-PR / issue entry for sweep-mode typed input. */
export type TaishiMergedPullRequest =
  TaishiSweepModeInput["mergedPullRequests"][number];

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
/**
 * Cached page may be reused only under bidirectional book×ticket scope equality.
 * - requested ticket present: page.issueNumber must equal it and bookKey matches
 * - requested ticket absent: only reuse a page that also lacks issueNumber
 *   (a narrower ticket page must not stand in for the full book page)
 */
function cachedPageMatchesRequestedScope(
  page: TaishiIssueMetricsPage,
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
  return resolveTaishiBookKey(input.projectRoot);
}

export async function readOrComputeTaishiIssuePage(
  input: TaishiIssueModeInput,
  /**
   * Cohort ensure only (#412): narrow the cache-miss recompute scan to this
   * root inside the already-selected book — a miss must never widen to a
   * whole-book scan for one index row. Not a public CLI face.
   */
  options?: { readonly scanProjectRoot?: string },
): Promise<TaishiIssueModeResult> {
  const ledgerHome = resolveActivationLedgerHome();
  const projectRoot = physicalPathIdentity(input.projectRoot);
  const bookKey = resolveIssueBookKey(input);
  const issueNumber = input.ticketNumber ?? input.issueNumber;
  const pagePath = taishiIssuePagePath(ledgerHome, {
    bookKey,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    // Sweep/legacy path-narrow pages (no ticket, no explicit CLI book-only scope).
    ...(issueNumber === undefined && input.bookKey === undefined
      ? { scopeRootIdentity: projectRoot }
      : {}),
  });

  try {
    const raw = await readFile(pagePath, "utf8");
    const page = JSON.parse(raw) as TaishiIssueMetricsPage;
    if (cachedPageMatchesRequestedScope(page, { bookKey, ...input })) {
      return { mode: "issue", page, pagePath };
    }
    // Existing page is for a different / absent ticket scope — same kernel recompute.
  } catch (error) {
    if (!isMissingPathError(error)) {
      // Corrupt / blocked page path — loud with issue identity, not absent.
      throw new TaishiIssueComputeError({
        bookKey,
        projectRoot,
        ...(issueNumber === undefined ? {} : { issueNumber }),
        cause: error,
      });
    }
  }

  try {
    return await runTaishiIssueMode(input, undefined, options?.scanProjectRoot);
  } catch (error) {
    if (error instanceof TaishiIssueComputeError) throw error;
    throw new TaishiIssueComputeError({
      bookKey,
      projectRoot,
      ...(issueNumber === undefined ? {} : { issueNumber }),
      cause: error,
    });
  }
}

async function runTaishiIssueMode(
  input: TaishiIssueModeInput | TaishiMergedPullRequest,
  /** Caller-supplied scan facts — skip a second ledger walk when already scanned. */
  precomputedScan?: TaishiScopedRunScan,
  /** Cohort ensure conjunction (#412): scan this root inside the selected book. */
  scanProjectRoot?: string,
): Promise<TaishiIssueModeResult> {
  // Programmatic issue/sweep entry boundary — same finite non-negative rule as attach schema.
  assertTaishiChangedLinesInput(input.changedLines);
  const ledgerHome = resolveActivationLedgerHome();
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
      ? await scanTaishiIssueRuns({
          bookKey: inputBookKey,
          ...(scanProjectRoot === undefined ? {} : { projectRoot: scanProjectRoot }),
          ...(ticketNumber === undefined ? {} : { ticketNumber }),
        })
      : ticketNumber === undefined
      ? await scanTaishiIssueRuns({ projectRoot })
      : await scanTaishiIssueRuns({ projectRoot, ticketNumber }));

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
  const page = await buildTaishiIssueMetricsPage({
    bookKey,
    projectRoot,
    runs: scan.runs,
    unreadable: scan.unreadable,
    scopeConflicts: scan.scopeConflicts,
    ...(input.changedLines === undefined ? {} : { changedLines: input.changedLines }),
    ...(issueNumber === undefined ? {} : { issueNumber }),
    ...(scopeRootIdentity === undefined ? {} : { scopeRootIdentity }),
  });

  const pagePath = await writeTaishiIssueMetricsPage(ledgerHome, page);

  // Issue number present → maintain library-index row for cohort join (sole remaining
  // consumer of the index; ticket CLI path never reads it — #399 D9).
  // Row carries bookKey so cross-book same ticket numbers do not merge (D5).
  // Locked read→upsert→write so concurrent issue/sweep CLI writers do not drop rows.
  if (issueNumber !== undefined) {
    await mergeTaishiLibraryIndexRows(ledgerHome, [
      rowFromIssueMetricsPage(page),
    ]);
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

  const upserts = issuePages.map((result) => rowFromIssueMetricsPage(result.page));
  const { index, indexPath } = await mergeTaishiLibraryIndexRows(ledgerHome, upserts);

  return { mode: "sweep", issuePages, index, indexPath };
}

async function runTaishiModelGroupsMode(
  input: TaishiModelGroupsModeInput,
): Promise<TaishiModelGroupsModeResult> {
  const ledgerHome = resolveActivationLedgerHome();

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

  // One ledger scan per root — shared by #338 ensure-page and model-group aggregate.
  // No second scan pass; sole issue kernel + existing writer when page is missing.
  for (const projectRoot of projectRoots) {
    const scan = await scanTaishiIssueRuns({ projectRoot });
    runs.push(...scan.runs);
    unreadable.push(...scan.unreadable);

    const bookKey = resolveIssueBookKey({ projectRoot });
    const pagePath = taishiIssuePagePath(ledgerHome, {
      bookKey,
      scopeRootIdentity: projectRoot,
    });
    try {
      const raw = await readFile(pagePath, "utf8");
      JSON.parse(raw); // present page must parse (same loud face as readOrCompute)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new TaishiIssueComputeError({ bookKey, projectRoot, cause: error });
      }
      try {
        // Reuse this root's scan facts — no second ledger walk on compute-if-missing.
        await runTaishiIssueMode({ mode: "issue", projectRoot }, scan);
      } catch (computeError) {
        if (computeError instanceof TaishiIssueComputeError) throw computeError;
        throw new TaishiIssueComputeError({ bookKey, projectRoot, cause: computeError });
      }
    }
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
 * - Model-groups mode: issue-set scope → one scan/root (ensure page #338 + aggregate).
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
    return runTaishiCohortMode(ledgerHome, input, async ({ projectRoot, issueNumber, bookKey }) => {
      // Real ledger book keys drive book scope. Synthetic `root:<id>` address keys
      // (sweep/legacy path-narrow) must not be used as books/ directory names.
      // issueNumber labels the page/index join only — not a ticketNumber scan filter
      // (cohort fixtures historically bind by projectRoot path, not typed ticket).
      const realBookKey =
        bookKey !== undefined && !bookKey.startsWith("root:")
          ? bookKey
          : undefined;
      const ensured = await readOrComputeTaishiIssuePage({
        mode: "issue",
        projectRoot,
        issueNumber,
        ...(realBookKey === undefined ? {} : { bookKey: realBookKey }),
      }, { scanProjectRoot: projectRoot });
      return ensured.page;
    });
  }
  if (input.mode === "model-groups") {
    return runTaishiModelGroupsMode(input);
  }
  return runTaishiIssueMode(input);
}
