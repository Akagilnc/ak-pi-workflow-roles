/**
 * The per-leg dossier files (docs/dossier-topology.md, #1161): `current.json`
 * (whole-file write), `history.jsonl` and `log.jsonl` (append-only, written only
 * through the sitian appender) and the one host original.
 *
 * `current.json` has one writer: the public call's own seam (admission, the
 * lifecycle transitions, settlement) — never a role runtime, a host adapter or a
 * gate. Everything those others learn is a record they append; each write here
 * recomputes the derived sections (`submission`, `officers`, `host`) from the
 * appended records, so a write by one process can never drop what another
 * process appended. The sections only the public call knows (`invocation`,
 * `admitted`, `runState`, `terminal`) are carried over from the file as read.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMissingPathError, isRecord } from "./unknown-value.ts";

export const RUN_CURRENT_FILE = "current.json" as const;
export const RUN_HISTORY_FILE = "history.jsonl" as const;
export const RUN_LOG_FILE = "log.jsonl" as const;

/** Sections only the public call knows; the writer carries them. */
export type CurrentSection = "invocation" | "admitted" | "runState" | "terminal";
/** Sections projected from appended records on every write. */
export type DerivedSection = "host" | "submission" | "officers";

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

/** One section of `current.json`; undefined when the file or the section is absent. */
export function readSectionSync(
  runDirectory: string,
  section: CurrentSection | DerivedSection,
): Record<string, unknown> | undefined {
  const value = readCurrentSync(runDirectory)?.[section];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`${RUN_CURRENT_FILE} ${section} section is not an object: ${runCurrentPath(runDirectory)}`);
  }
  return value;
}

/**
 * The appended rows of one run file, parsed; a missing file or a malformed line
 * is skipped. `undefined` when the file cannot be read at all: the projection is
 * a view and must not stop the public call's own write (a poisoned ledger never
 * stops a resume, #833); the file's own readers still fail loudly on it.
 */
function appendedRows(path: string): Record<string, unknown>[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return [];
    return undefined;
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // The damaged line stays in the file for its readers.
    }
  }
  return rows;
}

/**
 * `submission`, `officers` and `host` as the appended records currently say; a
 * section whose source file is unreadable keeps what the file last said.
 */
function deriveSections(
  runDirectory: string,
  previous: Record<string, unknown>,
): Record<DerivedSection, unknown> {
  const history = appendedRows(join(runDirectory, RUN_HISTORY_FILE));
  const log = appendedRows(join(runDirectory, RUN_LOG_FILE));
  let latest: Record<string, unknown> | undefined;
  const officers: Record<string, unknown> = {};
  for (const row of history ?? []) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (row.kind === "sealed" && payload !== undefined) {
      latest = { toolCallId: payload.toolCallId, role: payload.role, accepted: payload.accepted, at: row.timestamp };
    } else if (row.kind === "officer-pointer" && payload !== undefined && typeof payload.officer === "string") {
      officers[payload.officer] = payload;
    }
  }
  const sessions: Record<string, unknown> = {};
  let original: unknown;
  for (const row of log ?? []) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (row.kind === "host-session-id" && payload !== undefined && typeof payload.host === "string") {
      sessions[payload.host] = payload.sessionId;
    } else if (row.kind === "host-session" && payload?.type === "native-session-copy") {
      original = payload.landingPath;
    }
  }
  return {
    host: log === undefined ? previous.host : { sessions, ...(original === undefined ? {} : { original }) },
    submission: history === undefined ? previous.submission : latest === undefined ? {} : { latest },
    officers: history === undefined ? previous.officers : officers,
  };
}

function writeWhole(runDirectory: string, whole: Record<string, unknown>): void {
  const destination = runCurrentPath(runDirectory);
  const body = `${JSON.stringify(whole, null, 2)}\n`;
  // Same-directory temp + rename: a concurrent reader (the analyst scans live
  // runs) never sees a torn file. A run directory that cannot take a new entry
  // (settlement after a chmod) still accepts an in-place overwrite of the
  // writable file, so that case degrades instead of failing.
  const temporary = join(runDirectory, `.${RUN_CURRENT_FILE}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, body, "utf8");
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") throw error;
    writeFileSync(destination, body, "utf8");
  }
}

/** Write `current.json` whole: the carried sections with `change` applied, the derived ones recomputed. */
function commitCurrent(
  runDirectory: string,
  change: (carried: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
  const previous = readCurrentSync(runDirectory) ?? {};
  const carried: Record<string, unknown> = {};
  for (const section of ["invocation", "admitted", "runState", "terminal"] as const) {
    if (previous[section] !== undefined) carried[section] = previous[section];
  }
  const next = change(carried);
  if (next === undefined) return;
  const derived = deriveSections(runDirectory, previous);
  writeWhole(runDirectory, {
    ...next,
    ...Object.fromEntries(Object.entries(derived).filter(([, value]) => value !== undefined)),
  });
}

/** Replace one carried section, creating `current.json` when this is the first write. */
export function writeSectionSync(
  runDirectory: string,
  section: CurrentSection,
  value: Record<string, unknown>,
): void {
  commitCurrent(runDirectory, (carried) => ({ ...carried, [section]: value }));
}

/**
 * Let the caller keep its field rules for one existing carried section.
 * `undefined` means no change. A missing section is an error: admission writes
 * it first.
 */
export function updateSectionSync(
  runDirectory: string,
  section: CurrentSection,
  update: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
  commitCurrent(runDirectory, (carried) => {
    const current = carried[section];
    if (!isRecord(current)) {
      throw new Error(`${RUN_CURRENT_FILE} has no ${section} section: ${runCurrentPath(runDirectory)}`);
    }
    const next = update(current);
    return next === undefined ? undefined : { ...carried, [section]: next };
  });
}
