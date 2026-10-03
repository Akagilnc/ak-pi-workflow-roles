/**
 * The per-leg dossier files (docs/dossier-topology.md, #1161): `current.json`,
 * `history.jsonl` (the submission ledger and attempt history), `state.jsonl` (the four
 * whole pages) and `log.jsonl` (the rest), all append-only and written through the sitian appender, and the one host original.
 *
 * Facts are rows first. The four pages only the public call knows — identity
 * (`invocation`), admission (`admitted-request`), lifecycle (`run-state`) and the
 * terminal — are each rewritten whole by appending one `state.jsonl` row whose
 * payload is that page. `current.json` is a rendering: the last row of each kind
 * in the three row files, read at the moment of writing, never a value
 * carried from an earlier snapshot or from the previous `current.json`.
 *
 * Two public calls may exist on one leg (the live leg and a manual resume) and
 * both write `current.json`; there is no lock. After writing, a writer checks that
 * the row files are still the size it rendered from and, if rows were appended
 * meanwhile, renders again — so whichever writer finishes last has rendered from
 * every row, and the file ends equal to a fresh rendering.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { sessionFileOf } from "./role-run-placement.ts";
import { RUN_CURRENT_FILE, RUN_HISTORY_FILE, RUN_LOG_FILE, RUN_STATE_FILE } from "./run-dossier-files.ts";
import { appendSitianRecord } from "./sitian-appender.ts";
import { isMissingPathError, isRecord } from "./unknown-value.ts";

export { RUN_CURRENT_FILE, RUN_HISTORY_FILE, RUN_LOG_FILE, RUN_STATE_FILE };

/** Sections of `current.json` that are a whole page appended as one row. */
export type CurrentSection = "invocation" | "admitted" | "runState" | "terminal";
/** Sections rendered from rows other seams append. */
export type DerivedSection = "host" | "submission" | "officers";

/** The row kind of each whole-page section: the name of the file it replaced. */
const PAGE_ROW_KIND: Readonly<Record<CurrentSection, string>> = {
  invocation: "invocation",
  admitted: "admitted-request",
  runState: "run-state",
  terminal: "terminal",
};

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

/** One section of `current.json` (the rendering); undefined when the file or the section is absent. */
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

type RowFile = {
  readonly rows: Record<string, unknown>[];
  readonly bytes: number;
  /** The error code of a read that failed for a reason other than the file being absent. */
  readonly fault?: string;
};

/**
 * The rows of one run file as of this read, with the byte length they came from; a missing
 * file is empty, a malformed line is skipped. A file that cannot be read for any other reason
 * has no rows and carries its fault.
 */
function readRowFile(path: string): RowFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { rows: [], bytes: 0 };
    return { rows: [], bytes: 0, fault: String((error as NodeJS.ErrnoException).code ?? (error as Error).name) };
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
  return { rows, bytes: Buffer.byteLength(raw, "utf8") };
}

function fileBytes(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch (error) {
    return isMissingPathError(error) ? 0 : undefined;
  }
}

/** The payload of the last row of `kind`, or undefined. */
function lastPayload(rows: readonly Record<string, unknown>[], kind: string): Record<string, unknown> | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === kind && isRecord(row.payload)) return row.payload;
  }
  return undefined;
}

/** `current.json` as the rows say right now. */
function render(
  runDirectory: string,
  history: readonly Record<string, unknown>[],
  state: readonly Record<string, unknown>[],
  log: readonly Record<string, unknown>[],
  unreadable: Record<string, string>,
): Record<string, unknown> {
  const whole: Record<string, unknown> = {};
  for (const section of ["invocation", "admitted", "runState", "terminal"] as const) {
    const page = lastPayload(state, PAGE_ROW_KIND[section]);
    if (page !== undefined) whole[section] = page;
  }
  let latest: Record<string, unknown> | undefined;
  const officers: Record<string, unknown> = {};
  for (const row of history) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (row.kind === "sealed" && payload !== undefined) {
      latest = { toolCallId: payload.toolCallId, role: payload.role, accepted: payload.accepted, at: row.timestamp };
    } else if (row.kind === "officer-pointer" && payload !== undefined && typeof payload.officer === "string") {
      officers[payload.officer] = payload;
    }
  }
  const sessions: Record<string, unknown> = {};
  for (const row of state) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (row.kind === "host-session-id" && payload !== undefined && typeof payload.host === "string") {
      sessions[payload.host] = payload.sessionId;
    }
  }
  let original: unknown;
  for (const row of log) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (row.kind === "host-session" && payload?.type === "native-session-copy" && typeof payload.landingPath === "string") {
      original = payload.landingPath;
    }
  }
  // The copy row keeps the absolute path it was written to; a run that was filed under its ticket
  // since lives elsewhere. The original is projected from where this run directory is now.
  if (typeof original === "string") original = join(runDirectory, "session", basename(original));
  whole.host = { sessions, ...(original === undefined ? {} : { original }) };
  whole.submission = latest === undefined ? {} : { latest };
  whole.officers = officers;
  if (Object.keys(unreadable).length > 0) whole.unreadable = unreadable;
  return whole;
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

/**
 * Write `current.json` from the rows as read now; then, if a row file grew since that read,
 * render again. The last appender renders after its own append, so the loop ends when the
 * appends stop. A row file that cannot be read is rendered as having no rows and named in
 * the rendering's `unreadable` marker (file to error code), so a stale or partial rendering
 * is never silent.
 */
export function renderCurrentSync(runDirectory: string): void {
  const paths = [RUN_HISTORY_FILE, RUN_STATE_FILE, RUN_LOG_FILE].map((name) => join(runDirectory, name));
  for (;;) {
    const [history, state, log] = paths.map(readRowFile) as [RowFile, RowFile, RowFile];
    const unreadable: Record<string, string> = {};
    for (const [name, file] of [[RUN_HISTORY_FILE, history], [RUN_STATE_FILE, state], [RUN_LOG_FILE, log]] as const) {
      if (file.fault !== undefined) unreadable[name] = file.fault;
    }
    for (const [name, code] of Object.entries(unreadable)) {
      process.stderr.write(`[run-dossier] ${name} cannot be read (${code}); current.json is rendered without it: ${runDirectory}\n`);
    }
    writeWhole(runDirectory, render(runDirectory, history.rows, state.rows, log.rows, unreadable));
    const grew = [history, state, log].some((file, index) => file.fault === undefined && fileBytes(paths[index]!) !== file.bytes);
    if (!grew) return;
  }
}

function appendPageRow(runDirectory: string, section: CurrentSection, page: Record<string, unknown>): void {
  appendSitianRecord({
    level: "event",
    kind: PAGE_ROW_KIND[section],
    sessionParent: sessionFileOf(runDirectory),
    source: "run-dossier",
    payload: page,
  });
}

/** The current whole page of one section: the payload of its last row, never `current.json`. */
function currentPage(runDirectory: string, section: CurrentSection): Record<string, unknown> | undefined {
  const state = readRowFile(join(runDirectory, RUN_STATE_FILE));
  if (state.fault !== undefined) throw new Error(`${RUN_STATE_FILE} is unreadable (${state.fault}): ${runDirectory}`);
  return lastPayload(state.rows, PAGE_ROW_KIND[section]);
}

/**
 * The fact itself: a whole-page section as its last row says. The public call
 * reads its own facts here, not from the rendering, so a rendering that is stale
 * or refused changes nothing. Where no row exists (a run directory that holds
 * just a rendering) it falls back to `current.json`; a row file that cannot be
 * read fails closed — it never falls back to a rendering that may be older.
 */
export function readPageSync(runDirectory: string, section: CurrentSection): Record<string, unknown> | undefined {
  const state = readRowFile(join(runDirectory, RUN_STATE_FILE));
  if (state.fault !== undefined) throw new Error(`${RUN_STATE_FILE} is unreadable (${state.fault}): ${runDirectory}`);
  return lastPayload(state.rows, PAGE_ROW_KIND[section]) ?? readSectionSync(runDirectory, section);
}

/** Every row of history.jsonl, in order; a file that cannot be read throws. */
export function readHistoryRowsSync(runDirectory: string): readonly Record<string, unknown>[] {
  const history = readRowFile(join(runDirectory, RUN_HISTORY_FILE));
  if (history.fault !== undefined) throw new Error(`${RUN_HISTORY_FILE} is unreadable (${history.fault}): ${runDirectory}`);
  return history.rows;
}

/** Rewrite one section whole: append its row, then render `current.json`. */
export function writeSectionSync(
  runDirectory: string,
  section: CurrentSection,
  value: Record<string, unknown>,
): void {
  appendPageRow(runDirectory, section, value);
  renderCurrentSync(runDirectory);
}

/**
 * Let the caller keep its field rules for one existing section: the update
 * receives the last row's page. `undefined` means no change. A missing section
 * is an error: admission writes it first.
 */
export function updateSectionSync(
  runDirectory: string,
  section: CurrentSection,
  update: (current: Record<string, unknown>) => Record<string, unknown> | undefined,
): void {
  const current = currentPage(runDirectory, section);
  if (current === undefined) {
    throw new Error(`${RUN_STATE_FILE} has no ${PAGE_ROW_KIND[section]} row: ${runDirectory}`);
  }
  const next = update(current);
  if (next === undefined) return;
  writeSectionSync(runDirectory, section, next);
}
