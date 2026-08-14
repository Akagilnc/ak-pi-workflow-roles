/**
 * Taishi ledger scan: S-family book/runs topology, issue scope by invocation
 * projectRoot, and loud unreadable exclusion for required sources.
 * Reuses canonical session/artifact readers — does not parse session JSONL itself.
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
} from "./ledger-session-read.ts";
import { readRunTerminalArtifact } from "./run-terminal-artifacts.ts";
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

export type TaishiScopedRunScan = {
  readonly legs: readonly TaishiLegEntry[];
  readonly unreadable: readonly TaishiUnreadableRun[];
};

async function classifyScopedRun(input: {
  readonly book: string;
  readonly runId: string;
  readonly role: string;
  readonly runDirectory: string;
}): Promise<
  | { readonly kind: "leg"; readonly leg: TaishiLegEntry }
  | { readonly kind: "unreadable"; readonly entry: TaishiUnreadableRun }
> {
  const missingSources: TaishiMissingSource[] = [];
  const reasons: string[] = [];

  // 1) session timeline
  const sessionFile = await resolveSessionFile(input.runDirectory);
  let rows: Awaited<ReturnType<typeof readLedgerSessionJsonl>> | undefined;
  try {
    rows = await readLedgerSessionJsonl(sessionFile);
    const span = extractSessionTimestampSpan(rows);
    if (span.startedAt === undefined || span.endedAt === undefined) {
      missingSources.push("session-timeline");
      reasons.push("session timeline has no usable timestamps");
    }
  } catch (error) {
    missingSources.push("session-timeline");
    reasons.push(errorText(error));
  }

  // 2) tool association (only when session rows are available)
  if (rows !== undefined && !missingSources.includes("session-timeline")) {
    try {
      extractSessionToolIntervals(rows);
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

  return {
    kind: "leg",
    leg: {
      runId: input.runId,
      book: input.book,
      role: input.role,
    },
  };
}

/**
 * Scan ledger home books/<book>/runs for runs whose invocation projectRoot matches
 * the issue scope. Damaged required sources become unreadable exclusions.
 */
export async function scanTaishiIssueRuns(input: {
  readonly projectRoot: string;
  readonly home?: string;
}): Promise<TaishiScopedRunScan> {
  const ledgerHome = resolveActivationLedgerHome(
    input.home === undefined ? undefined : () => input.home!,
  );
  const scopeIdentity = physicalPathIdentity(input.projectRoot);
  const booksRoot = join(ledgerHome, "books");

  let bookNames: string[];
  try {
    const entries = await readdir(booksRoot, { withFileTypes: true });
    bookNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (error) {
    if (isMissingPathError(error)) {
      return { legs: [], unreadable: [] };
    }
    throw error;
  }

  const legs: TaishiLegEntry[] = [];
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
      if (classified.kind === "leg") legs.push(classified.leg);
      else unreadable.push(classified.entry);
    }
  }

  return { legs, unreadable };
}
