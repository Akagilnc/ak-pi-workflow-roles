/**
 * The per-leg dossier files (docs/dossier-topology.md, #1161): `history.jsonl` (the
 * submission ledger), `state.jsonl` (the four whole pages) and `log.jsonl` (the rest),
 * all append-only and written through the sitian appender, and the one host original.
 *
 * Facts are rows. The four pages only the public call knows — identity
 * (`invocation`), admission (`admitted-request`), lifecycle (`run-state`) and the
 * terminal — are each rewritten whole by appending one `state.jsonl` row whose
 * payload is that page; the last row of a kind is the current page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sessionFileOf } from "./role-run-placement.ts";
import { RUN_HISTORY_FILE, RUN_LOG_FILE, RUN_STATE_FILE, OFFICER_POINTER_RECORD_KIND } from "./run-dossier-files.ts";
import { appendSitianRecord } from "./sitian-appender.ts";
import { parseSitianRecordText } from "./sitian-reader.ts";
import { isMissingPathError, isRecord } from "./unknown-value.ts";

export { RUN_HISTORY_FILE, RUN_LOG_FILE, RUN_STATE_FILE };

/** The whole-page sections a public call rewrites by appending one `state.jsonl` row. */
export type CurrentSection = "invocation" | "admitted" | "runState" | "terminal";

/** The row kind of each whole-page section: the name of the file it replaced. */
const PAGE_ROW_KIND: Readonly<Record<CurrentSection, string>> = {
  invocation: "invocation",
  admitted: "admitted-request",
  runState: "run-state",
  terminal: "terminal",
};

type RowFile = {
  readonly rows: Record<string, unknown>[];
  /** The error code of a read that failed for a reason other than the file being absent. */
  readonly fault?: string;
  /** Canonical malformed-line diagnostics from the sole Sitian decoder. */
  readonly diagnostics?: readonly { readonly line: number; readonly error: string }[];
};

/**
 * The rows of one run file as of this read.
 * Missing file → empty. IO fault → no rows + fault code. Damaged lines keep the sole
 * Sitian decoder's diagnostics and do not invent a second skip parser.
 */
function readRowFile(path: string): RowFile {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return { rows: [] };
    return { rows: [], fault: String((error as NodeJS.ErrnoException).code ?? (error as Error).name) };
  }
  const { records, diagnostics } = parseSitianRecordText(buffer.toString("utf8"));
  return {
    rows: [...records] as Record<string, unknown>[],
    ...(diagnostics.length > 0
      ? { diagnostics: diagnostics.map((d) => ({ line: d.line, error: d.error })) }
      : {}),
  };
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
 * Sole reducer for the "last booking wins per officer" rule on archived rows
 * (#753 / #1161; historical decode only).
 * A booked officer-pointer row with a non-object payload or non-string officer is
 * damaged topology — never silently omitted into lawful zero rounds (#1161 O1).
 * Absence of any officer-pointer row remains lawful empty.
 * Invalid input is a TypeError (same class as other dossier illegal payloads).
 * Control readers (`readBookedOfficerPointers`) let this throw into the existing
 * auditor-roles unreadable seam.
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

/** Append one whole-page row; returns the file the row landed in. */
function appendPageRow(runDirectory: string, section: CurrentSection, page: Record<string, unknown>): string {
  return appendSitianRecord({
    level: "event",
    kind: PAGE_ROW_KIND[section],
    sessionParent: sessionFileOf(runDirectory),
    source: "run-dossier",
    payload: page,
  }).recordFile;
}

/**
 * Control-plane rows of `state.jsonl` (#1161 / #1178).
 * IO fault and decoder diagnostics refuse — reachable older facts must not
 * silently drive lifecycle. Missing file is empty. Observation that keeps
 * reachable rows after damage still uses `readStateRowsSync`.
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

/**
 * A whole-page section as its last row says. Absence of a row is absence. A row
 * file that cannot be read fails closed. An illegal (non-object) latest payload
 * keeps its failure identity; it is not filtered into absence.
 */
export function readPageSync(runDirectory: string, section: CurrentSection): Record<string, unknown> | undefined {
  return lastPagePayload(readStateControlRowsSync(runDirectory), PAGE_ROW_KIND[section], runDirectory);
}

/**
 * Every row of state.jsonl, in order; a file that cannot be read throws.
 * Wide observation path: decoder diagnostics are not a hard refuse.
 * Control consumers must use `readStateControlRowsSync`.
 */
export function readStateRowsSync(runDirectory: string): readonly Record<string, unknown>[] {
  const state = readRowFile(join(runDirectory, RUN_STATE_FILE));
  if (state.fault !== undefined) throw new Error(`${RUN_STATE_FILE} is unreadable (${state.fault}): ${runDirectory}`);
  return state.rows;
}

/** Rewrite one section whole by appending its row; returns the row's file. */
export function writeSectionSync(
  runDirectory: string,
  section: CurrentSection,
  value: Record<string, unknown>,
): string {
  return appendPageRow(runDirectory, section, value);
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
