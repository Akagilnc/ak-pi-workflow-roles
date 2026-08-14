/**
 * Canonical reader for run-directory typed terminal artifacts.
 * Layout owner is settlement publish*Artifacts (report.json / error.json /
 * audit-incomplete.json under artifacts/). This module only reads presence
 * and structural readability — it does not re-derive role outcomes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const RUN_TERMINAL_ARTIFACT_FILES = [
  "report.json",
  "error.json",
  "audit-incomplete.json",
] as const;

export type RunTerminalArtifactFile = (typeof RUN_TERMINAL_ARTIFACT_FILES)[number];

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

/**
 * Read the first present typed terminal artifact under runDir/artifacts/.
 * Absence of every known file is a valid no-receipt state (not unreadable).
 * A present file that cannot be parsed as a usable typed JSON object is unreadable.
 */
export async function readRunTerminalArtifact(
  runDirectory: string,
): Promise<RunTerminalArtifactRead> {
  const artifactsDir = join(runDirectory, "artifacts");
  for (const file of RUN_TERMINAL_ARTIFACT_FILES) {
    const path = join(artifactsDir, file);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) continue;
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
  return { status: "absent" };
}
