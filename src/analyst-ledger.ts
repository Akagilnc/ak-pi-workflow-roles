/**
 * Analyst ledger scan: S-family book/runs topology, book × ticket issue scope
 * (#399), and loud unreadable exclusion for required sources.
 * Reuses canonical session/artifact readers — does not parse session JSONL itself.
 *
 * Scope unit = ledger book (git common-dir key) × optional typed ticket filter.
 * CLI issue query never path-filters by projectRoot (owner #399: that face deleted).
 * Sweep/legacy library may still pass projectRoot as a path-narrow when bookKey
 * is absent — recording-side field, not the public query mechanical key.
 * Typed ticketNumber, when requested, decides alone (no silent projectRoot fallback).
 *
 * A2: classifyScopedRun retains typed per-run facts (frame span, tool intervals,
 * terminal face) for metric-family modules — no longer discarded after checks.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import {
  extractSessionModelSequence,
  extractSessionTimestampSpan,
  extractSessionToolIntervals,
  LedgerSessionJsonlError,
  readLedgerSessionJsonl,
  type SessionToolInterval,
} from "./ledger-session-read.ts";
import {
  readRunTerminalArtifact,
  type RunTerminalArtifactFile,
} from "./run-terminal-artifacts.ts";
import type {
  AnalystFirstFrameAt,
  AnalystMissingSource,
  AnalystOptionalTimestamp,
  AnalystScopeConflict,
  AnalystUnreadableRun,
} from "./analyst-page.ts";
import {
  readAnalystGateCyclesFromAuditorRoles,
  type AnalystGateCycleRound,
} from "./analyst-gate-cycles-read.ts";

export type { AnalystGateCycleRound } from "./analyst-gate-cycles-read.ts";

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Existing public-cli run-state live phases — not a new state machine. */
const LIVE_RUN_STATES = new Set(["admitted", "running", "resumable"]);

/**
 * Read lifecycle state from the existing run-state.json face.
 * Used only to distinguish live in-flight runs from terminal no-receipt.
 */
async function readExistingRunLifecycleState(
  runDirectory: string,
): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(runDirectory, "run-state.json"), "utf8"),
    );
    if (!isRecord(raw) || typeof raw.state !== "string") return undefined;
    return raw.state;
  } catch {
    return undefined;
  }
}

function parseRunDirectoryName(
  name: string,
): { runId: string; role: string } | undefined {
  const at = name.lastIndexOf("@");
  if (at <= 0 || at === name.length - 1) return undefined;
  return { runId: name.slice(0, at), role: name.slice(at + 1) };
}

/**
 * Invocation scope faces used for issue 圈定 (C4 / #399).
 * projectRoot is retained for narrow path match and conflict facts;
 * ticketNumber is the #176 typed face when present (integer ≥ 1).
 * Single read of invocation.json — no second parse kernel.
 */
type InvocationScopeFields = {
  readonly projectRoot: string;
  readonly ticketNumber?: number;
};

/** Best-effort book key from a projectRoot git common-dir; undefined when not a git tree. */
function tryResolveBookKeyFromProjectRoot(projectRoot: string): string | undefined {
  try {
    return resolveBookKeyFromGit(projectRoot);
  } catch {
    return undefined;
  }
}

async function listLedgerBookNames(booksRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(booksRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function readInvocationScopeFields(
  runDirectory: string,
): Promise<InvocationScopeFields | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(runDirectory, "invocation.json"), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.projectRoot !== "string" || parsed.projectRoot.trim() === "") {
    return undefined;
  }
  const projectRoot = parsed.projectRoot;
  // Same #176 contract: positive integer ticketNumber only.
  if (
    typeof parsed.ticketNumber === "number"
    && Number.isInteger(parsed.ticketNumber)
    && parsed.ticketNumber >= 1
  ) {
    return { projectRoot, ticketNumber: parsed.ticketNumber };
  }
  return { projectRoot };
}

/**
 * Issue scope decision for one run (#399 / C4).
 * - Scope ticket set → typed ticket alone decides (match in; else out).
 *   No projectRoot fallback — that silent path labeled full-project pages as ticket N.
 * - Whole-book scope (CLI bare / bookKey without ticket) → every run in the book.
 * - Path-narrow (sweep/legacy only): no ticket + scopeRootIdentity → path match.
 */
function decideIssueScope(input: {
  readonly scopeTicketNumber: number | undefined;
  /** Whole-book membership when true (CLI bare / git-resolved book). */
  readonly wholeBook: boolean;
  readonly scopeRootIdentity: string | undefined;
  readonly runProjectRootIdentity: string;
  readonly runTicketNumber: number | undefined;
}): { readonly inScope: boolean } {
  if (input.scopeTicketNumber !== undefined) {
    // Strict (book, N): typed ticket alone; never fall back to path match.
    return { inScope: input.runTicketNumber === input.scopeTicketNumber };
  }

  if (input.wholeBook) {
    return { inScope: true };
  }

  if (input.scopeRootIdentity !== undefined) {
    return {
      inScope: input.runProjectRootIdentity === input.scopeRootIdentity,
    };
  }

  return { inScope: true };
}

async function resolveSessionFile(
  runDirectory: string,
): Promise<string> {
  // Prefer invocation.sessionFile when present; fall back to S-family principal.
  try {
    const raw = await readFile(join(runDirectory, "invocation.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed)
      && typeof parsed.sessionFile === "string"
      && parsed.sessionFile.trim() !== ""
    ) {
      return parsed.sessionFile;
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return join(runDirectory, "session", "session.jsonl");
}

/** Session first/last usable timestamps retained for B-wave wall-clock kernels. */
export type AnalystRunFrameSpan = {
  readonly startedAt: string;
  readonly endedAt: string;
};

/**
 * Typed terminal face retained for B-wave outcome mapping.
 * Absence is a valid no-receipt state; unreadable never appears here (excluded).
 */
export type AnalystRunTerminalFace =
  | { readonly status: "absent" }
  | {
      readonly status: "present";
      readonly file: RunTerminalArtifactFile;
      readonly body: Record<string, unknown>;
      /** Nonblank producer role — sole owner is readRunTerminalArtifact. */
      readonly role: string;
    };

/**
 * Per readable in-scope run: identity + facts classifyScopedRun already read.
 * Metric families consume this structure read-only; they do not re-scan disk.
 */
export type AnalystReadableRunFacts = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly frameSpan: AnalystRunFrameSpan;
  readonly toolIntervals: readonly SessionToolInterval[];
  readonly terminal: AnalystRunTerminalFace;
  /**
   * Ordered-unique session model ids for this leg (C3 model-group key material).
   * Empty when no model face was present — not a scan-level unreadable condition
   * (timeline/tools/terminal still admit the run for issue-mode families).
   * Model-groups mode lists empty as typed session-model vacancy, never as "".
   */
  readonly models: readonly string[];
  /**
   * Paired gate-cycle rounds from session/auditor-roles/ (#446).
   * Missing directory → empty (lawful zero rounds).
   * Damaged discovered nested JSONL → leg unreadable (`auditor-roles` source).
   */
  readonly gateCycles: readonly AnalystGateCycleRound[];
};

export type AnalystScopedRunScan = {
  /** Readable in-scope runs with retained typed facts (A2). */
  readonly runs: readonly AnalystReadableRunFacts[];
  readonly unreadable: readonly AnalystUnreadableRun[];
  /** C4: typed-ticket admits whose projectRoot mechanical key conflicted. */
  readonly scopeConflicts: readonly AnalystScopeConflict[];
};

async function classifyScopedRun(input: {
  readonly book: string;
  readonly runId: string;
  readonly role: string;
  readonly runDirectory: string;
}): Promise<
  | { readonly kind: "readable"; readonly facts: AnalystReadableRunFacts }
  | { readonly kind: "unreadable"; readonly entry: AnalystUnreadableRun }
  | { readonly kind: "live" }
> {
  const missingSources: AnalystMissingSource[] = [];
  const reasons: string[] = [];

  let frameSpan: AnalystRunFrameSpan | undefined;
  let toolIntervals: readonly SessionToolInterval[] | undefined;
  let terminal: AnalystRunTerminalFace | undefined;
  /** Ordered-unique models retained whenever session rows were readable. */
  let models: readonly string[] = [];
  /** Partial first/last frame retained when full session span cannot be admitted. */
  let partialFirstFrameAt: AnalystFirstFrameAt = { status: "absent" };
  let partialLastFrameAt: AnalystOptionalTimestamp = { status: "absent" };

  // 1) session timeline
  const sessionFile = await resolveSessionFile(input.runDirectory);
  let rows: Awaited<ReturnType<typeof readLedgerSessionJsonl>> | undefined;
  try {
    rows = await readLedgerSessionJsonl(sessionFile);
    models = extractSessionModelSequence(rows);
    const span = extractSessionTimestampSpan(rows);
    if (span.startedAt === undefined || span.endedAt === undefined) {
      missingSources.push("session-timeline");
      reasons.push("session timeline has no usable timestamps");
      // Span incomplete, but any usable timestamp remains a typed partial fact.
      if (span.startedAt !== undefined) {
        partialFirstFrameAt = { status: "present", at: span.startedAt };
      }
      if (span.endedAt !== undefined) {
        partialLastFrameAt = { status: "present", at: span.endedAt };
      }
    } else {
      // frameSpan gate: both edges must parse and end must not precede start.
      // Damaged spans stay page-local unreadable — never throw or emit negative/NaN wallMs.
      const startedMs = Date.parse(span.startedAt);
      const endedMs = Date.parse(span.endedAt);
      if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
        missingSources.push("session-timeline");
        reasons.push("session timeline timestamps are not parseable instants");
        partialFirstFrameAt = { status: "present", at: span.startedAt };
        partialLastFrameAt = { status: "present", at: span.endedAt };
      } else if (endedMs < startedMs) {
        missingSources.push("session-timeline");
        reasons.push("session timeline end is earlier than start");
        partialFirstFrameAt = { status: "present", at: span.startedAt };
        partialLastFrameAt = { status: "present", at: span.endedAt };
      } else {
        frameSpan = { startedAt: span.startedAt, endedAt: span.endedAt };
      }
    }
  } catch (error) {
    missingSources.push("session-timeline");
    reasons.push(errorText(error));
    // Single parse kernel: recover first/last frame and models from rows read before the loud line.
    if (error instanceof LedgerSessionJsonlError) {
      const span = extractSessionTimestampSpan(error.prefixRows);
      if (span.startedAt !== undefined) {
        partialFirstFrameAt = { status: "present", at: span.startedAt };
      }
      if (span.endedAt !== undefined) {
        partialLastFrameAt = { status: "present", at: span.endedAt };
      }
      models = extractSessionModelSequence(error.prefixRows);
    }
  }

  // 2) tool association (only when session rows are available)
  if (rows !== undefined && !missingSources.includes("session-timeline")) {
    try {
      toolIntervals = extractSessionToolIntervals(rows);
    } catch (error) {
      missingSources.push("tool-association");
      reasons.push(errorText(error));
    }
  }

  // 3) typed terminal artifact — absence is no-receipt only for terminal runs.
  // Live admitted/running/resumable runs (existing run-state) are not dead legs.
  try {
    const artifact = await readRunTerminalArtifact(input.runDirectory);
    if (artifact.status === "unreadable") {
      missingSources.push("terminal-artifact");
      reasons.push(`${artifact.file}: ${artifact.reason}`);
    } else if (artifact.status === "absent") {
      const lifecycle = await readExistingRunLifecycleState(input.runDirectory);
      if (lifecycle !== undefined && LIVE_RUN_STATES.has(lifecycle)) {
        return { kind: "live" };
      }
      terminal = { status: "absent" };
    } else {
      // role already required nonblank by readRunTerminalArtifact (single owner).
      terminal = {
        status: "present",
        file: artifact.file,
        body: artifact.body,
        role: artifact.body.role as string,
      };
    }
  } catch (error) {
    missingSources.push("terminal-artifact");
    reasons.push(errorText(error));
  }

  if (missingSources.length > 0) {
    // Prefer full-span edges when session was admitted; else partial prefix facts.
    const firstFrameAt: AnalystFirstFrameAt =
      frameSpan !== undefined
        ? { status: "present", at: frameSpan.startedAt }
        : partialFirstFrameAt;
    const lastFrameAt: AnalystOptionalTimestamp =
      frameSpan !== undefined
        ? { status: "present", at: frameSpan.endedAt }
        : partialLastFrameAt;
    return {
      kind: "unreadable",
      entry: {
        runId: input.runId,
        book: input.book,
        missingSources,
        reason: reasons.join("; "),
        firstFrameAt,
        lastFrameAt,
      },
    };
  }

  // All three faces present after the gate above (TypeScript cannot see the link).
  if (frameSpan === undefined || toolIntervals === undefined || terminal === undefined) {
    throw new Error(
      `classifyScopedRun internal invariant: missing retained facts for ${input.runId}`,
    );
  }

  // Nested auditor-roles gate pairs stay inside the sole scan (families must
  // not readdir this tree again). Missing directory → []. Damaged discovered
  // nested JSONL is page-local unreadable — never silently under-count rounds.
  let gateCycles: readonly AnalystGateCycleRound[];
  try {
    gateCycles = await readAnalystGateCyclesFromAuditorRoles(
      join(input.runDirectory, "session", "auditor-roles"),
    );
  } catch (error) {
    return {
      kind: "unreadable",
      entry: {
        runId: input.runId,
        book: input.book,
        missingSources: ["auditor-roles"],
        reason: errorText(error),
        firstFrameAt: { status: "present", at: frameSpan.startedAt },
        lastFrameAt: { status: "present", at: frameSpan.endedAt },
      },
    };
  }

  return {
    kind: "readable",
    facts: {
      runId: input.runId,
      book: input.book,
      role: input.role,
      frameSpan,
      toolIntervals,
      terminal,
      models,
      gateCycles,
    },
  };
}

/**
 * Scan ledger home books/<book>/runs for runs in the issue scope.
 * #399: scope = book × optional ticket.
 * - bookKey set → that book only; whole-book when no ticket and no projectRoot;
 *   ticket filters alone; bookKey + projectRoot (cohort ensure, #412) narrows
 *   to that root inside the book.
 * - projectRoot without bookKey (sweep/legacy): git-resolved → whole that book;
 *   non-git → path-narrow across books (fixture isolation).
 * Damaged required sources become unreadable exclusions.
 * Readable runs retain typed facts for metric-family composition.
 */
export async function scanAnalystIssueRuns(input: {
  /** Explicit book key — CLI issue query always supplies this. */
  readonly bookKey?: string;
  /** Caller typed ticket face — when set, only matching invocation.ticketNumber admits. */
  readonly ticketNumber?: number;
  /**
   * Sweep/legacy path-narrow pointer. Not a CLI issue-query face (#399 deleted).
   * When bookKey absent: git common-dir → whole book; else path filter.
   */
  readonly projectRoot?: string;
}): Promise<AnalystScopedRunScan> {
  // Package-owned machine home only (ADR 0048) — no invocation-varying override.
  const ledgerHome = resolveActivationLedgerHome();
  const scopeTicketNumber = input.ticketNumber;
  const booksRoot = join(ledgerHome, "books");

  let wholeBook = false;
  let scopeRootIdentity: string | undefined;
  let bookNames: string[];

  if (input.bookKey !== undefined && input.bookKey.trim() !== "") {
    bookNames = [input.bookKey];
    if (input.projectRoot !== undefined) {
      // Cohort ensure conjunction (#412): the index join already selected the
      // row — a cache-miss recompute must stay inside this root of this book,
      // never inhale sibling roots' runs into one issue page.
      wholeBook = false;
      scopeRootIdentity = physicalPathIdentity(input.projectRoot);
    } else {
      // CLI book scope: whole book unless ticket filters. Never path-narrow.
      wholeBook = true;
    }
  } else if (input.projectRoot !== undefined) {
    const resolved = tryResolveBookKeyFromProjectRoot(input.projectRoot);
    if (resolved !== undefined) {
      bookNames = [resolved];
      wholeBook = true;
    } else {
      bookNames = await listLedgerBookNames(booksRoot);
      scopeRootIdentity = physicalPathIdentity(input.projectRoot);
    }
  } else {
    bookNames = await listLedgerBookNames(booksRoot);
    wholeBook = true;
  }

  if (bookNames.length === 0) {
    return { runs: [], unreadable: [], scopeConflicts: [] };
  }

  const runs: AnalystReadableRunFacts[] = [];
  const unreadable: AnalystUnreadableRun[] = [];
  // scopeConflicts retained on the scan face for page envelope compat; book×ticket
  // scope no longer emits projectRoot dual-key conflicts on the CLI path.
  const scopeConflicts: AnalystScopeConflict[] = [];

  for (const book of bookNames) {
    const runsDir = join(booksRoot, book, "runs");
    let runNames: string[];
    try {
      const entries = await readdir(runsDir, { withFileTypes: true });
      runNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }

    for (const runName of runNames) {
      const parsed = parseRunDirectoryName(runName);
      if (parsed === undefined) continue;
      const runDirectory = join(runsDir, runName);

      let scopeFields: InvocationScopeFields | undefined;
      try {
        scopeFields = await readInvocationScopeFields(runDirectory);
      } catch (error) {
        // Corrupt invocation cannot be scoped to this issue — skip.
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (scopeFields === undefined) continue;

      const runProjectRootIdentity = physicalPathIdentity(scopeFields.projectRoot);
      const decision = decideIssueScope({
        scopeTicketNumber,
        wholeBook,
        scopeRootIdentity,
        runProjectRootIdentity,
        runTicketNumber: scopeFields.ticketNumber,
      });
      if (!decision.inScope) continue;

      const classified = await classifyScopedRun({
        book,
        runId: parsed.runId,
        role: parsed.role,
        runDirectory,
      });
      if (classified.kind === "readable") runs.push(classified.facts);
      else if (classified.kind === "unreadable") unreadable.push(classified.entry);
      // live in-flight runs are omitted from legs and unreadable (not failure/death).
    }
  }

  return {
    runs,
    unreadable,
    scopeConflicts,
  };
}
