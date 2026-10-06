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
import { basename, join, sep } from "node:path";

import { sessionFileOf } from "./role-run-placement.ts";
import { RUN_CURRENT_FILE, RUN_HISTORY_FILE, RUN_LOG_FILE, RUN_STATE_FILE, OFFICER_POINTER_RECORD_KIND } from "./run-dossier-files.ts";
import { appendSitianRecord } from "./sitian-appender.ts";
import { parseSitianRecordText } from "./sitian-reader.ts";
import { isMissingPathError, isRecord } from "./unknown-value.ts";

/**
 * #1183: current.json location fields follow the directory being rendered.
 * Fact rows stay as written; only the rendering projects stored→actual.
 * Kept local so render does not import role-run-relocation (cycle via pages).
 */
function projectRenderedPagePaths(
  page: Record<string, unknown>,
  actualRunDirectory: string,
): Record<string, unknown> {
  const stored =
    typeof page.runDirectory === "string" && page.runDirectory.trim() !== ""
      ? page.runDirectory
      : undefined;
  if (stored === undefined || stored === actualRunDirectory) return page;

  const projectValue = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    if (value === stored) return actualRunDirectory;
    const prefix = `${stored}${sep}`;
    if (value.startsWith(prefix)) {
      return `${actualRunDirectory}${value.slice(stored.length)}`;
    }
    return value;
  };

  const projectFields = (
    record: Record<string, unknown>,
    fields: readonly string[],
  ): Record<string, unknown> => {
    let changed = false;
    const next = { ...record };
    for (const field of fields) {
      if (!(field in next)) continue;
      const projected = projectValue(next[field]);
      if (projected !== next[field]) {
        next[field] = projected;
        changed = true;
      }
    }
    return changed ? next : record;
  };

  let out = projectFields(page, [
    "runDirectory",
    "sessionDirectory",
    "sessionFile",
    "admittedRequestPath",
    "mergerInputPath",
    "sourceRunPath",
  ]);
  if (isRecord(out.principal)) {
    const principal = projectFields(out.principal, ["sessionDirectory", "sessionFile"]);
    if (principal !== out.principal) out = { ...out, principal };
  }
  if (isRecord(out.sourceRun)) {
    const sourceRun = projectFields(out.sourceRun, ["runDirectory"]);
    if (sourceRun !== out.sourceRun) out = { ...out, sourceRun };
  }
  return out;
}

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
  /** Physical on-disk byte length of this read — never a re-encoded string length. */
  readonly bytes: number;
  /** The error code of a read that failed for a reason other than the file being absent. */
  readonly fault?: string;
  /** Canonical malformed-line diagnostics from the sole Sitian decoder. */
  readonly diagnostics?: readonly { readonly line: number; readonly error: string }[];
};

/**
 * The rows of one run file as of this read, with the physical byte length they came from.
 * Missing file → empty. IO fault → no rows + fault code. Damaged lines keep the sole
 * Sitian decoder's diagnostics and do not invent a second skip parser.
 */
function readRowFile(path: string): RowFile {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return { rows: [], bytes: 0 };
    return { rows: [], bytes: 0, fault: String((error as NodeJS.ErrnoException).code ?? (error as Error).name) };
  }
  const { records, diagnostics } = parseSitianRecordText(buffer.toString("utf8"));
  return {
    rows: [...records] as Record<string, unknown>[],
    bytes: buffer.length,
    ...(diagnostics.length > 0
      ? { diagnostics: diagnostics.map((d) => ({ line: d.line, error: d.error })) }
      : {}),
  };
}

function fileBytes(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch (error) {
    return isMissingPathError(error) ? 0 : undefined;
  }
}

/**
 * Payload of the last row of `kind`, or undefined when no such row exists.
 * Non-object payloads are returned as-is: a later illegal whole page must not
 * be washed into an older valid page or into absence.
 */
function lastPayloadOfKind(rows: readonly Record<string, unknown>[], kind: string): unknown {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === kind) return row.payload;
  }
  return undefined;
}

/** Last whole-page payload as an object, or undefined when absent; illegal values throw. */
function lastPagePayload(
  rows: readonly Record<string, unknown>[],
  kind: string,
  runDirectory: string,
): Record<string, unknown> | undefined {
  const payload = lastPayloadOfKind(rows, kind);
  if (payload === undefined) return undefined;
  if (!isRecord(payload)) {
    throw new TypeError(`${RUN_STATE_FILE} ${kind} payload is not an object: ${runDirectory}`);
  }
  return payload;
}

/**
 * Latest officer-pointer payload per officer from already-decoded history rows.
 * Sole reducer for the "last booking wins per officer" rule (#753 / #1161 officers).
 * A booked officer-pointer row with a non-object payload or non-string officer is
 * damaged topology — never silently omitted into lawful zero rounds (#1161 O1).
 * Absence of any officer-pointer row remains lawful empty.
 * Invalid input is a TypeError (same class as other dossier illegal payloads).
 * Control readers (`readBookedOfficerPointers`) let this throw into the existing
 * auditor-roles unreadable seam; `render` catches only that TypeError and marks
 * `history.jsonl` unreadable so other reachable facts stay in current.json.
 */
export function latestOfficerPointersFromRecords(
  records: readonly { readonly kind?: unknown; readonly payload?: unknown }[],
): Readonly<Record<string, unknown>> {
  const latest: Record<string, unknown> = {};
  for (const record of records) {
    if (record.kind !== OFFICER_POINTER_RECORD_KIND) continue;
    if (!isRecord(record.payload) || typeof record.payload.officer !== "string") {
      throw new TypeError("officer-pointer payload is not a record with string officer");
    }
    latest[record.payload.officer] = record.payload;
  }
  return latest;
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
    const page = lastPayloadOfKind(state, PAGE_ROW_KIND[section]);
    if (page === undefined) continue;
    // #1183: location fields track the directory being rendered; fact rows stay put.
    if (
      (section === "invocation" || section === "admitted" || section === "runState")
      && isRecord(page)
    ) {
      whole[section] = projectRenderedPagePaths(page, runDirectory);
    } else {
      whole[section] = page;
    }
  }
  let latest: Record<string, unknown> | undefined;
  for (const row of history) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (row.kind === "sealed" && payload !== undefined) {
      latest = { toolCallId: payload.toolCallId, role: payload.role, accepted: payload.accepted, at: row.timestamp };
    }
  }
  // Control readers still fail closed via latestOfficerPointersFromRecords.
  // Render must keep other reachable facts and surface damage on the existing
  // file unreadable seam — never abort the whole current.json (#1161 O1).
  // Catch only the reducer's known TypeError; unknown throws stay unknown
  // (never wash into malformed by free-text message).
  let officers: Readonly<Record<string, unknown>> = {};
  try {
    officers = latestOfficerPointersFromRecords(history);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    if (unreadable[RUN_HISTORY_FILE] === undefined) unreadable[RUN_HISTORY_FILE] = "malformed";
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
 * Process-local once-declare for unreadable row files (Node.js emitWarning
 * "Avoiding duplicate warnings": once per process, not keyed off the durable
 * rendering). Key = runDirectory + file name; value = last declared code.
 */
const declaredUnreadable = new Map<string, string>();

/**
 * Write `current.json` from the rows as read now; then, if a row file grew since that read,
 * render again. The last appender renders after its own append, so the loop ends when the
 * appends stop. A row file that cannot be read is rendered as having no rows and named in
 * the rendering's `unreadable` marker (file to error code), so a stale or partial rendering
 * is never silent. Declaration does not read the previous rendering: a damaged
 * `current.json` must not block fact append, re-render, or public resume.
 */
export function renderCurrentSync(runDirectory: string): void {
  const paths = [RUN_HISTORY_FILE, RUN_STATE_FILE, RUN_LOG_FILE].map((name) => join(runDirectory, name));
  for (;;) {
    const [history, state, log] = paths.map(readRowFile) as [RowFile, RowFile, RowFile];
    const unreadable: Record<string, string> = {};
    for (const [name, file] of [[RUN_HISTORY_FILE, history], [RUN_STATE_FILE, state], [RUN_LOG_FILE, log]] as const) {
      if (file.fault !== undefined) unreadable[name] = file.fault;
      else if (file.diagnostics !== undefined && file.diagnostics.length > 0) unreadable[name] = "malformed";
    }
    // Render may add officer-pointer TypeError damage onto the same unreadable map;
    // declare after render so that cause enters the existing diagnostics/unreadable seam.
    const whole = render(runDirectory, history.rows, state.rows, log.rows, unreadable);
    for (const [name, code] of Object.entries(unreadable)) {
      const key = `${runDirectory}\0${name}`;
      if (declaredUnreadable.get(key) === code) continue;
      const detail = code === "malformed"
        ? `${name} has malformed row(s); current.json keeps reachable rows and retains the diagnostic`
        : `${name} cannot be read (${code}); current.json is rendered without it`;
      process.stderr.write(`[run-dossier] ${detail}: ${runDirectory}\n`);
      declaredUnreadable.set(key, code);
    }
    writeWhole(runDirectory, whole);
    // Growth uses physical bytes; a malformed diagnostic must not skip the check.
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

/**
 * The fact itself: a whole-page section as its last row says. The public call
 * reads its own facts here, not from the rendering, so a rendering that is stale
 * or refused changes nothing. Absence of a row is absence — never a `current.json`
 * fallback. A row file that cannot be read fails closed. An illegal (non-object)
 * latest payload keeps its failure identity; it is not filtered into absence.
 */
/**
 * Control-plane rows of `state.jsonl` (#1161 / #1178).
 * IO fault and decoder diagnostics refuse — reachable older facts must not
 * silently drive lifecycle. Missing file is empty. Rendering / observation that
 * keeps reachable rows after damage still uses `readStateRowsSync`.
 * Sole owner of this fail-closed policy; page readers and worker gate share it.
 */
export function readStateControlRowsSync(runDirectory: string): readonly Record<string, unknown>[] {
  const state = readRowFile(join(runDirectory, RUN_STATE_FILE));
  if (state.fault !== undefined) throw new Error(`${RUN_STATE_FILE} is unreadable (${state.fault}): ${runDirectory}`);
  if (state.diagnostics !== undefined && state.diagnostics.length > 0) {
    throw new Error(
      `${RUN_STATE_FILE} has malformed row(s); refusing stale control-plane page: ${runDirectory}`,
    );
  }
  return state.rows;
}

export function readPageSync(runDirectory: string, section: CurrentSection): Record<string, unknown> | undefined {
  return lastPagePayload(readStateControlRowsSync(runDirectory), PAGE_ROW_KIND[section], runDirectory);
}

/** Every row of history.jsonl, in order; a file that cannot be read throws. */
export function readHistoryRowsSync(runDirectory: string): readonly Record<string, unknown>[] {
  const history = readRowFile(join(runDirectory, RUN_HISTORY_FILE));
  if (history.fault !== undefined) throw new Error(`${RUN_HISTORY_FILE} is unreadable (${history.fault}): ${runDirectory}`);
  return history.rows;
}

/**
 * Every row of state.jsonl, in order; a file that cannot be read throws.
 * Wide observation path: decoder diagnostics are not a hard refuse (render keeps
 * reachable rows). Control consumers must use `readStateControlRowsSync`.
 */
export function readStateRowsSync(runDirectory: string): readonly Record<string, unknown>[] {
  const state = readRowFile(join(runDirectory, RUN_STATE_FILE));
  if (state.fault !== undefined) throw new Error(`${RUN_STATE_FILE} is unreadable (${state.fault}): ${runDirectory}`);
  return state.rows;
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
  const current = readPageSync(runDirectory, section);
  if (current === undefined) {
    throw new Error(`${RUN_STATE_FILE} has no ${PAGE_ROW_KIND[section]} row: ${runDirectory}`);
  }
  const next = update(current);
  if (next === undefined) return;
  writeSectionSync(runDirectory, section, next);
}
