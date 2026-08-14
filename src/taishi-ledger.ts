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
  extractSessionTimestampSpan,
  extractSessionToolIntervals,
  readLedgerSessionJsonl,
  type SessionToolInterval,
} from "./ledger-session-read.ts";
import {
  readRunTerminalArtifact,
  type RunTerminalArtifactFile,
} from "./run-terminal-artifacts.ts";
import type {
  TaishiLegEntry,
  TaishiMissingSource,
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

async function readInvocationProjectRoot(
  runDirectory: string,
): Promise<string | undefined> {
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
  return parsed.projectRoot;
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
};

export type TaishiScopedRunScan = {
  /** Readable in-scope runs with retained typed facts (A2). */
  readonly runs: readonly TaishiReadableRunFacts[];
  /** A1 leg projection — identity only, derived from runs (not a second source). */
  readonly legs: readonly TaishiLegEntry[];
  readonly unreadable: readonly TaishiUnreadableRun[];
};

function toLegEntry(facts: TaishiReadableRunFacts): TaishiLegEntry {
  return {
    runId: facts.runId,
    book: facts.book,
    role: facts.role,
  };
}

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

  // 1) session timeline
  const sessionFile = await resolveSessionFile(input.runDirectory);
  let rows: Awaited<ReturnType<typeof readLedgerSessionJsonl>> | undefined;
  try {
    rows = await readLedgerSessionJsonl(sessionFile);
    const span = extractSessionTimestampSpan(rows);
    if (span.startedAt === undefined || span.endedAt === undefined) {
      missingSources.push("session-timeline");
      reasons.push("session timeline has no usable timestamps");
    } else {
      frameSpan = { startedAt: span.startedAt, endedAt: span.endedAt };
    }
  } catch (error) {
    missingSources.push("session-timeline");
    reasons.push(errorText(error));
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
      terminal = {
        status: "present",
        file: artifact.file,
        body: artifact.body,
      };
    }
  } catch (error) {
    missingSources.push("terminal-artifact");
    reasons.push(errorText(error));
  }

  if (missingSources.length > 0) {
    return {
      kind: "unreadable",
      entry: {
        runId: input.runId,
        book: input.book,
        missingSources,
        reason: reasons.join("; "),
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
    },
  };
}

/**
 * Scan ledger home books/<book>/runs for runs whose invocation projectRoot matches
 * the issue scope. Damaged required sources become unreadable exclusions.
 * Readable runs retain typed facts for metric-family composition.
 */
export async function scanTaishiIssueRuns(input: {
  readonly projectRoot: string;
}): Promise<TaishiScopedRunScan> {
  // Package-owned machine home only (ADR 0048) — no invocation-varying override.
  const ledgerHome = resolveActivationLedgerHome();
  const scopeIdentity = physicalPathIdentity(input.projectRoot);
  const booksRoot = join(ledgerHome, "books");

  let bookNames: string[];
  try {
    const entries = await readdir(booksRoot, { withFileTypes: true });
    bookNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (isMissingPathError(error)) {
      return { runs: [], legs: [], unreadable: [] };
    }
    throw error;
  }

  const runs: TaishiReadableRunFacts[] = [];
  const unreadable: TaishiUnreadableRun[] = [];

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

      let projectRoot: string | undefined;
      try {
        projectRoot = await readInvocationProjectRoot(runDirectory);
      } catch (error) {
        // Corrupt invocation cannot be scoped to this issue — skip.
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (projectRoot === undefined) continue;
      if (physicalPathIdentity(projectRoot) !== scopeIdentity) continue;

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
    legs: runs.map(toLegEntry),
    unreadable,
  };
}
