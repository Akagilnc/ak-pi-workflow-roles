/**
 * Canonical reader for run-directory typed terminal artifacts.
 * Layout owner is settlement publish*Artifacts (report.json / error.json /
 * audit-incomplete.json under artifacts/, plus the same publisher's durable
 * failure fallbacks). This module only reads presence and structural
 * readability — it does not re-derive role outcomes or invent a second
 * candidate algorithm.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { roleRunArtifactsDirectory } from "./role-run-placement.ts";

export const RUN_TERMINAL_ARTIFACT_FILES = [
  "report.json",
  "error.json",
  "audit-incomplete.json",
] as const;

export type RunTerminalArtifactFile = (typeof RUN_TERMINAL_ARTIFACT_FILES)[number];

/**
 * Fixed durable failure paths publishFailureArtifacts may settle when the
 * conventional artifacts/error.json name cannot be written. Shared face so the
 * reader follows the publisher — not a parallel search algorithm.
 * Relative to the run directory.
 */
export const RUN_TERMINAL_ERROR_FALLBACK_RELATIVE_PATHS = [
  "artifacts/error.settlement.json",
  "error.settlement.json",
] as const;

/**
 * Project an absolute path under the run directory to a run-relative openable
 * pointer (posix separators, no runId path bytes). Same public-face boundary as
 * engine-detour `discloseRecordFile: false` (#108 / #537): once the run
 * directory is known from `resume.command` (or top-level `runId`), the relative
 * path reopens the durable file. Returns `undefined` when the path is outside
 * the run directory.
 */
export function projectRunRelativeOpenablePath(
  runDirectory: string,
  absolutePath: string,
): string | undefined {
  const rel = relative(resolve(runDirectory), resolve(absolutePath));
  if (
    rel.length === 0
    || rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) {
    return undefined;
  }
  return rel.split(sep).join("/");
}

/**
 * Public-face exact-token redaction for resumable Terminals (#108 / #990):
 * strip every occurrence of `runId` from structured values and dynamic object
 * keys so typed regions outside `resume.command` cannot re-disclose it.
 * Durable artifacts keep the original bytes; only the public projection uses this.
 *
 * Dynamic-key projection must remain complete: when two distinct source keys
 * collapse to the same projected key, return an ordered `[projectedKey, value]`
 * entry list for that object instead of silently overwriting earlier values.
 */
export function redactExactRunIdToken(value: unknown, runId: string): unknown {
  if (runId.length === 0) return value;
  if (typeof value === "string") {
    return value.includes(runId) ? value.split(runId).join("") : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactExactRunIdToken(item, runId));
  }
  if (value !== null && typeof value === "object") {
    const projectedEntries: Array<[string, unknown]> = [];
    const out: Record<string, unknown> = {};
    let collided = false;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const projectedKey = key.includes(runId) ? key.split(runId).join("") : key;
      const projectedValue = redactExactRunIdToken(entry, runId);
      projectedEntries.push([projectedKey, projectedValue]);
      if (Object.prototype.hasOwnProperty.call(out, projectedKey)) {
        collided = true;
        continue;
      }
      out[projectedKey] = projectedValue;
    }
    return collided ? projectedEntries : out;
  }
  return value;
}

/**
 * #108 / #990: project the complete public resumable Terminal face in place.
 * Exact runId tokens may remain only inside `resume.command`; every other
 * public region (roleOutcome, navigator, artifacts, submissions, gate, …) is
 * redacted. Callers keep private dossier / history bytes unprojected.
 */
export function projectResumablePublicTerminalFace(
  terminal: {
    roleOutcome: unknown;
    navigator?: unknown;
    artifacts?: unknown;
    submissions?: unknown;
    gate?: unknown;
    autoResumeCount?: unknown;
    reviewerChildren?: unknown;
    reviewerChildOutcomes?: unknown;
    resume?: { command: string };
    runId?: unknown;
  },
  runId: string,
): void {
  if (terminal.resume === undefined || runId.length === 0) return;
  const resume = terminal.resume;
  const projected = redactExactRunIdToken(
    {
      roleOutcome: terminal.roleOutcome,
      navigator: terminal.navigator,
      artifacts: terminal.artifacts,
      submissions: terminal.submissions,
      gate: terminal.gate,
      autoResumeCount: terminal.autoResumeCount,
      reviewerChildren: terminal.reviewerChildren,
      reviewerChildOutcomes: terminal.reviewerChildOutcomes,
      runId: terminal.runId,
    },
    runId,
  ) as {
    roleOutcome: unknown;
    navigator?: unknown;
    artifacts?: unknown;
    submissions?: unknown;
    gate?: unknown;
    autoResumeCount?: unknown;
    reviewerChildren?: unknown;
    reviewerChildOutcomes?: unknown;
    runId?: unknown;
  };
  terminal.roleOutcome = projected.roleOutcome;
  if ("navigator" in projected) terminal.navigator = projected.navigator as typeof terminal.navigator;
  if ("artifacts" in projected) {
    terminal.artifacts = projected.artifacts as typeof terminal.artifacts;
  }
  if ("submissions" in projected) {
    terminal.submissions = projected.submissions as typeof terminal.submissions;
  }
  if ("gate" in projected) terminal.gate = projected.gate as typeof terminal.gate;
  if ("autoResumeCount" in projected) {
    terminal.autoResumeCount = projected.autoResumeCount as typeof terminal.autoResumeCount;
  }
  if ("reviewerChildren" in projected) {
    terminal.reviewerChildren =
      projected.reviewerChildren as typeof terminal.reviewerChildren;
  }
  if ("reviewerChildOutcomes" in projected) {
    terminal.reviewerChildOutcomes =
      projected.reviewerChildOutcomes as typeof terminal.reviewerChildOutcomes;
  }
  if ("runId" in projected) terminal.runId = projected.runId as typeof terminal.runId;
  // resume.command is the sole public carrier of the exact runId token.
  terminal.resume = resume;
}

/** Unique open-ended failure names: error.<uuid>.json (publisher stem + uuid). */
const UNIQUE_ERROR_FALLBACK_NAME =
  /^error\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

export type RunTerminalArtifactRead =
  | { readonly status: "absent" }
  | {
      readonly status: "present";
      readonly file: RunTerminalArtifactFile;
      readonly path: string;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly status: "unreadable";
      readonly file: RunTerminalArtifactFile;
      readonly path: string;
      readonly reason: string;
    };

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

/**
 * Minimum producer-owned face shared by settlement terminal artifacts
 * (report / error / audit-incomplete). Consumer-driven: enough to identify a
 * usable typed terminal artifact; null, arrays, primitives, and role-less
 * objects are unreadable (ADR 0043).
 */
function readUsableTerminalArtifactBody(
  body: unknown,
): { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (body === null) {
    return { ok: false, reason: "terminal artifact JSON value is null" };
  }
  if (!isRecord(body)) {
    return {
      ok: false,
      reason: `terminal artifact JSON value is not a typed object (${Array.isArray(body) ? "array" : typeof body})`,
    };
  }
  if (typeof body.role !== "string" || body.role.trim() === "") {
    return {
      ok: false,
      reason: "terminal artifact missing nonblank producer-owned role field",
    };
  }
  return { ok: true, body };
}

async function readTerminalArtifactAtPath(
  path: string,
  file: RunTerminalArtifactFile,
): Promise<RunTerminalArtifactRead | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    return {
      status: "unreadable",
      file,
      path,
      reason: errorText(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "unreadable",
      file,
      path,
      reason:
        error instanceof Error
          ? error.message
          : `terminal artifact JSON parse failed: ${String(error)}`,
    };
  }
  const usable = readUsableTerminalArtifactBody(parsed);
  if (!usable.ok) {
    return {
      status: "unreadable",
      file,
      path,
      reason: usable.reason,
    };
  }
  return { status: "present", file, path, body: usable.body };
}

async function listUniqueErrorFallbackPaths(
  directories: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const dir of directories) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!UNIQUE_ERROR_FALLBACK_NAME.test(name)) continue;
      found.push(join(dir, name));
    }
  }
  return found;
}

/**
 * Publisher run-directory face is `<runId>@<role>`. Parent-directory unique
 * fallbacks are shared across sibling runs, so binding uses this runId only.
 * Sole authority for runDirectory → runId (last `@` split).
 */
export function runIdFromRunDirectory(runDirectory: string): string | undefined {
  const name = basename(runDirectory);
  const at = name.lastIndexOf("@");
  if (at <= 0 || at === name.length - 1) return undefined;
  return name.slice(0, at);
}

/**
 * Shared parent-directory unique fallback may be adopted only when the
 * publisher-owned body.runId equals this run directory's runId. Same-run
 * artifactsDir / runDirectory candidates keep path ownership and skip this.
 * expectedRunId undefined (unparseable run dir) → never bound.
 */
function presentUniqueFallbackBoundToRun(
  body: Record<string, unknown>,
  expectedRunId: string | undefined,
): boolean {
  if (expectedRunId === undefined) return false;
  return typeof body.runId === "string" && body.runId === expectedRunId;
}

/**
 * Sole authority for seam-owned unique error.<uuid>.json candidates.
 * Used by both clearOpposite (settlement) and readRunTerminalArtifact — do not
 * re-enumerate the same-run / parent unique set elsewhere.
 * Ownership:
 * - same-run dirs (artifacts/, runDir): path ownership — all unique names
 * - parent runs/: only body.runId-bound faces; unparseable runId or unreadable body → none
 */
export async function listSeamOwnedUniqueErrorFacePaths(
  runDirectory: string,
): Promise<readonly string[]> {
  const artifactsDir = roleRunArtifactsDirectory(runDirectory);
  const owned: string[] = await listUniqueErrorFallbackPaths([
    artifactsDir,
    runDirectory,
  ]);
  const expectedRunId = runIdFromRunDirectory(runDirectory);
  for (const path of await listUniqueErrorFallbackPaths([dirname(runDirectory)])) {
    const read = await readTerminalArtifactAtPath(path, "error.json");
    if (read === undefined || read.status !== "present") continue;
    if (!presentUniqueFallbackBoundToRun(read.body, expectedRunId)) continue;
    owned.push(path);
  }
  return owned;
}

type PresentOrUnreadable = Exclude<RunTerminalArtifactRead, { status: "absent" }>;

/**
 * Publish contract (#953): only failure publish continues after clearOpposite
 * failure, so a multi-class residue (residual report/audit beside a new error
 * face) means the current settlement is failure. Prefer failure-class faces
 * over success/audit — never filesystem mtime (copy/restore/utimes can lie).
 */
function failureClassRank(file: RunTerminalArtifactFile): number {
  return file === "error.json" ? 1 : 0;
}

/**
 * Read the current typed terminal artifact for a run directory.
 *
 * Candidate set (publisher-owned faces only):
 * 1) conventional artifacts/{report,error,audit-incomplete}.json
 * 2) publisher fixed failure fallbacks (error.settlement.json faces)
 * 3) seam-owned unique error.<uuid>.json via listSeamOwnedUniqueErrorFacePaths
 *    (same-run path ownership + parent body.runId binding — shared with clear)
 *
 * Invariant: when more than one present face remains (e.g. clearOpposite failed
 * during failure publish and a fallback was settled beside a residual report),
 * adopt failure-class over success/audit by the publish contract — not mtime.
 * Same-class ties keep candidate enumeration order (conventional before
 * fallbacks before unique).
 *
 * Unreadable faces never outrank a present face. Parent unique unreadable
 * files never enter the shared enumerator (cannot prove run identity).
 * Absence of every known durable face is a valid no-receipt state.
 */
export async function readRunTerminalArtifact(
  runDirectory: string,
): Promise<RunTerminalArtifactRead> {
  const artifactsDir = roleRunArtifactsDirectory(runDirectory);
  const present: Array<Extract<PresentOrUnreadable, { status: "present" }>> = [];
  const unreadable: Array<Extract<PresentOrUnreadable, { status: "unreadable" }>> =
    [];

  const consider = (read: RunTerminalArtifactRead | undefined): void => {
    if (read === undefined || read.status === "absent") return;
    if (read.status === "present") {
      present.push(read);
      return;
    }
    unreadable.push(read);
  };

  for (const file of RUN_TERMINAL_ARTIFACT_FILES) {
    consider(await readTerminalArtifactAtPath(join(artifactsDir, file), file));
  }

  for (const relative of RUN_TERMINAL_ERROR_FALLBACK_RELATIVE_PATHS) {
    consider(
      await readTerminalArtifactAtPath(join(runDirectory, relative), "error.json"),
    );
  }

  // Unique same-run + parent-bound faces: one enumerator shared with clear.
  for (const path of await listSeamOwnedUniqueErrorFacePaths(runDirectory)) {
    consider(await readTerminalArtifactAtPath(path, "error.json"));
  }

  if (present.length > 0) {
    present.sort(
      (a, b) => failureClassRank(b.file) - failureClassRank(a.file),
    );
    return present[0]!;
  }
  if (unreadable.length > 0) {
    return unreadable[0]!;
  }
  return { status: "absent" };
}

/** Test/helper: basename face of a unique fallback path, if any. */
export function isUniqueErrorFallbackName(name: string): boolean {
  return UNIQUE_ERROR_FALLBACK_NAME.test(basename(name));
}
