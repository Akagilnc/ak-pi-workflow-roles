/**
 * Taishi ledger scan: S-family book/runs topology, issue scope by invocation
 * projectRoot, and loud unreadable exclusion for required sources.
 * Reuses canonical session/artifact readers — does not parse session JSONL itself.
 *
 * A2: classifyScopedRun retains typed per-run facts (frame span, tool intervals,
 * terminal face) for metric-family modules — no longer discarded after checks.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
  TaishiFirstFrameAt,
  TaishiMissingSource,
  TaishiOptionalTimestamp,
  TaishiScopeConflict,
  TaishiUnreadableRun,
} from "./taishi-page.ts";

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

function parseRunDirectoryName(
  name: string,
): { runId: string; role: string } | undefined {
  const at = name.lastIndexOf("@");
  if (at <= 0 || at === name.length - 1) return undefined;
  return { runId: name.slice(0, at), role: name.slice(at + 1) };
}

/**
 * Invocation scope faces used for issue 圈定 (C4).
 * projectRoot remains required to place a run on any scope path;
 * ticketNumber is the #176 typed face when present (integer ≥ 1).
 * Single read of invocation.json — no second parse kernel.
 */
type InvocationScopeFields = {
  readonly projectRoot: string;
  readonly ticketNumber?: number;
};

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
 * C4 issue scope decision for one run.
 * - Both sides carry ticketNumber → typed ticket decides; mismatch projectRoot = conflict.
 * - Otherwise → projectRoot mechanical-key fallback.
 */
function decideIssueScope(input: {
  readonly scopeProjectRootIdentity: string;
  readonly scopeTicketNumber: number | undefined;
  readonly runProjectRootIdentity: string;
  readonly runTicketNumber: number | undefined;
}): { readonly inScope: boolean; readonly conflict: boolean } {
  const projectRootMatch =
    input.runProjectRootIdentity === input.scopeProjectRootIdentity;

  if (
    input.scopeTicketNumber !== undefined
    && input.runTicketNumber !== undefined
  ) {
    if (input.runTicketNumber === input.scopeTicketNumber) {
      return { inScope: true, conflict: !projectRootMatch };
    }
    // Run bound to a different ticket — typed face wins over projectRoot match.
    return { inScope: false, conflict: false };
  }

  return { inScope: projectRootMatch, conflict: false };
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
export type TaishiRunFrameSpan = {
  readonly startedAt: string;
  readonly endedAt: string;
};

/**
 * Typed terminal face retained for B-wave outcome mapping.
 * Absence is a valid no-receipt state; unreadable never appears here (excluded).
 */
export type TaishiRunTerminalFace =
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
export type TaishiReadableRunFacts = {
  readonly runId: string;
  readonly book: string;
  readonly role: string;
  readonly frameSpan: TaishiRunFrameSpan;
  readonly toolIntervals: readonly SessionToolInterval[];
  readonly terminal: TaishiRunTerminalFace;
  /**
   * Ordered-unique session model ids for this leg (C3 model-group key material).
   * Empty when no model face was present — not a scan-level unreadable condition
   * (timeline/tools/terminal still admit the run for issue-mode families).
   * Model-groups mode lists empty as typed session-model vacancy, never as "".
   */
  readonly models: readonly string[];
};

export type TaishiScopedRunScan = {
  /** Readable in-scope runs with retained typed facts (A2). */
  readonly runs: readonly TaishiReadableRunFacts[];
  readonly unreadable: readonly TaishiUnreadableRun[];
  /** C4: typed-ticket admits whose projectRoot mechanical key conflicted. */
  readonly scopeConflicts: readonly TaishiScopeConflict[];
};

async function classifyScopedRun(input: {
  readonly book: string;
  readonly runId: string;
  readonly role: string;
  readonly runDirectory: string;
}): Promise<
  | { readonly kind: "readable"; readonly facts: TaishiReadableRunFacts }
  | { readonly kind: "unreadable"; readonly entry: TaishiUnreadableRun }
> {
  const missingSources: TaishiMissingSource[] = [];
  const reasons: string[] = [];

  let frameSpan: TaishiRunFrameSpan | undefined;
  let toolIntervals: readonly SessionToolInterval[] | undefined;
  let terminal: TaishiRunTerminalFace | undefined;
  /** Ordered-unique models retained whenever session rows were readable. */
  let models: readonly string[] = [];
  /** Partial first/last frame retained when full session span cannot be admitted. */
  let partialFirstFrameAt: TaishiFirstFrameAt = { status: "absent" };
  let partialLastFrameAt: TaishiOptionalTimestamp = { status: "absent" };

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

  // 3) typed terminal artifact — absence is no-receipt (valid); unreadable is not.
  try {
    const artifact = await readRunTerminalArtifact(input.runDirectory);
    if (artifact.status === "unreadable") {
      missingSources.push("terminal-artifact");
      reasons.push(`${artifact.file}: ${artifact.reason}`);
    } else if (artifact.status === "absent") {
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
    const firstFrameAt: TaishiFirstFrameAt =
      frameSpan !== undefined
        ? { status: "present", at: frameSpan.startedAt }
        : partialFirstFrameAt;
    const lastFrameAt: TaishiOptionalTimestamp =
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
    },
  };
}

/**
 * Scan ledger home books/<book>/runs for runs in the issue scope.
 * C4: typed ticketNumber (when present on both scope and run) decides membership;
 * otherwise projectRoot mechanical key is the fallback. Ticket-vs-projectRoot
 * conflicts still admit the run and surface on scopeConflicts.
 * Damaged required sources become unreadable exclusions.
 * Readable runs retain typed facts for metric-family composition.
 */
export async function scanTaishiIssueRuns(input: {
  readonly projectRoot: string;
  /** Caller typed ticket face — when set, prefer #176 invocation ticketNumber. */
  readonly ticketNumber?: number;
}): Promise<TaishiScopedRunScan> {
  // Package-owned machine home only (ADR 0048) — no invocation-varying override.
  const ledgerHome = resolveActivationLedgerHome();
  const scopeIdentity = physicalPathIdentity(input.projectRoot);
  const scopeTicketNumber = input.ticketNumber;
  const booksRoot = join(ledgerHome, "books");

  let bookNames: string[];
  try {
    const entries = await readdir(booksRoot, { withFileTypes: true });
    bookNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (isMissingPathError(error)) {
      return { runs: [], unreadable: [], scopeConflicts: [] };
    }
    throw error;
  }

  const runs: TaishiReadableRunFacts[] = [];
  const unreadable: TaishiUnreadableRun[] = [];
  const scopeConflicts: TaishiScopeConflict[] = [];

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
        scopeProjectRootIdentity: scopeIdentity,
        scopeTicketNumber,
        runProjectRootIdentity,
        runTicketNumber: scopeFields.ticketNumber,
      });
      if (!decision.inScope) continue;

      if (decision.conflict) {
        // ticketNumber is defined on both sides whenever conflict is true.
        scopeConflicts.push({
          runId: parsed.runId,
          ticketNumber: scopeFields.ticketNumber as number,
          projectRoot: runProjectRootIdentity,
          fact: "typed-ticketNumber-over-projectRoot",
        });
      }

      const classified = await classifyScopedRun({
        book,
        runId: parsed.runId,
        role: parsed.role,
        runDirectory,
      });
      if (classified.kind === "readable") runs.push(classified.facts);
      else unreadable.push(classified.entry);
    }
  }

  return {
    runs,
    unreadable,
    scopeConflicts,
  };
}
