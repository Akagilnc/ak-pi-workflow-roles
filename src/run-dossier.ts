/**
 * Single authority for the per-leg dossier files (docs/dossier-topology.md, #1161):
 * `current.json` (whole-file rewrite), `history.jsonl` (append-only),
 * `log.jsonl` (sitian stream) and the one host original. Callers name a section
 * of `current.json`; no caller addresses the file path or serializes it itself.
 *
 * Read-modify-write is synchronous: within one process it cannot interleave.
 * Across processes the writers take turns by construction — the parent CLI is
 * parked on the child leg while the child writes (diarist ticket bind).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMissingPathError, isRecord } from "./unknown-value.ts";

export const RUN_CURRENT_FILE = "current.json" as const;
export const RUN_HISTORY_FILE = "history.jsonl" as const;
export const RUN_LOG_FILE = "log.jsonl" as const;

/** Sections of `current.json`. One name per source page of the old sixteen files. */
export type CurrentSection =
  | "invocation"
  | "admitted"
  | "runState"
  | "host"
  | "officers";

export function runCurrentPath(runDirectory: string): string {
  return join(runDirectory, RUN_CURRENT_FILE);
}

/** The whole `current.json`, or undefined when absent (ENOENT only). */
export function readCurrentSync(runDirectory: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(runCurrentPath(runDirectory), "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new TypeError(`${RUN_CURRENT_FILE} is not an object: ${runCurrentPath(runDirectory)}`);
  return parsed;
}

function writeCurrentSync(runDirectory: string, current: Record<string, unknown>): void {
  // In-place overwrite, like the page files it replaces: a writable file in a
  // read-only run directory (settlement after a chmod) must stay writable.
  writeFileSync(runCurrentPath(runDirectory), `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

/** One section of `current.json`; undefined when the file or the section is absent. */
export function readSectionSync(
  runDirectory: string,
  section: CurrentSection,
): Record<string, unknown> | undefined {
  const value = readCurrentSync(runDirectory)?.[section];
  return isRecord(value) ? value : undefined;
}

/** Replace one section, creating `current.json` when this is the first write. */
export function writeSectionSync(
  runDirectory: string,
  section: CurrentSection,
  value: Record<string, unknown>,
): void {
  writeCurrentSync(runDirectory, { ...(readCurrentSync(runDirectory) ?? {}), [section]: value });
}

/**
 * Let the caller keep its field rules for one existing section. `undefined`
 * means no change. A missing section is an error: admission writes it first.
 */
export function updateSectionSync(
  runDirectory: string,
  section: CurrentSection,
  update: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
  const whole = readCurrentSync(runDirectory);
  const current = whole?.[section];
  if (whole === undefined || !isRecord(current)) {
    throw new Error(`${RUN_CURRENT_FILE} has no ${section} section: ${runCurrentPath(runDirectory)}`);
  }
  const next = update(current);
  if (next === undefined) return;
  writeCurrentSync(runDirectory, { ...whole, [section]: next });
}
