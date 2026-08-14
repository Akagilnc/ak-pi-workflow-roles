/**
 * Canonical reader for run-directory typed terminal artifacts.
 * Layout owner is settlement publish*Artifacts (report.json / error.json /
 * audit-incomplete.json under artifacts/, plus the same publisher's durable
 * failure fallbacks). This module only reads presence and structural
 * readability — it does not re-derive role outcomes or invent a second
 * candidate algorithm.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
 */
function runIdFromRunDirectory(runDirectory: string): string | undefined {
  const name = basename(runDirectory);
  const at = name.lastIndexOf("@");
  if (at <= 0 || at === name.length - 1) return undefined;
  return name.slice(0, at);
}

/**
 * Shared parent-directory unique fallback may be adopted only when the
 * publisher-owned body.runId equals this run directory's runId. Same-run
 * artifactsDir / runDirectory candidates keep path ownership and skip this.
 */
function presentUniqueFallbackBoundToRun(
  body: Record<string, unknown>,
  expectedRunId: string | undefined,
): boolean {
  if (expectedRunId === undefined) return false;
  return typeof body.runId === "string" && body.runId === expectedRunId;
}

/**
 * Read the first present typed terminal artifact for a run directory.
 * Order:
 * 1) conventional artifacts/{report,error,audit-incomplete}.json
 * 2) publisher fixed failure fallbacks (error.settlement.json faces)
 * 3) publisher unique error.<uuid>.json fallbacks under same-run dirs
 * 4) shared parent-directory unique fallbacks bound by body.runId
 *
 * Absence of every known durable face is a valid no-receipt state (not unreadable).
 * A present file that cannot be parsed as a usable typed JSON object is unreadable.
 */
export async function readRunTerminalArtifact(
  runDirectory: string,
): Promise<RunTerminalArtifactRead> {
  const artifactsDir = join(runDirectory, "artifacts");
  for (const file of RUN_TERMINAL_ARTIFACT_FILES) {
    const path = join(artifactsDir, file);
    const read = await readTerminalArtifactAtPath(path, file);
    if (read !== undefined) return read;
  }

  // Publisher settled a durable failure outside the conventional error.json name.
  for (const relative of RUN_TERMINAL_ERROR_FALLBACK_RELATIVE_PATHS) {
    const path = join(runDirectory, relative);
    const read = await readTerminalArtifactAtPath(path, "error.json");
    if (read !== undefined) return read;
  }

  // Same-run unique faces: path ownership is the run itself — no cross-run risk.
  for (const path of await listUniqueErrorFallbackPaths([artifactsDir, runDirectory])) {
    const read = await readTerminalArtifactAtPath(path, "error.json");
    if (read !== undefined) return read;
  }

  // Shared parent (runs/) unique faces: require publisher runId binding.
  const expectedRunId = runIdFromRunDirectory(runDirectory);
  for (const path of await listUniqueErrorFallbackPaths([dirname(runDirectory)])) {
    const read = await readTerminalArtifactAtPath(path, "error.json");
    if (read === undefined) continue;
    if (read.status === "present") {
      if (!presentUniqueFallbackBoundToRun(read.body, expectedRunId)) continue;
      return read;
    }
    // Unreadable parent unique file cannot prove run identity — do not adopt.
  }

  return { status: "absent" };
}

/** Test/helper: basename face of a unique fallback path, if any. */
export function isUniqueErrorFallbackName(name: string): boolean {
  return UNIQUE_ERROR_FALLBACK_NAME.test(basename(name));
}
