/**
 * Raw run-dossier row access for tests (docs/dossier-topology.md, #1161).
 * Independent of src/run-dossier.ts on purpose: tests assert on the bytes a
 * reader outside the package would see, and seed fixtures without the
 * production writer.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { CurrentSection } from "../../src/run-dossier.ts";
import { reportRunRecord } from "../../src/sitian-facade.ts";
import { POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE } from "../../src/public-cli/settlement.ts";

/** The state.jsonl row kind of each whole-page section: the name of the file it replaced. */
const PAGE_ROW_KIND: Readonly<Record<CurrentSection, string>> = {
  invocation: "invocation",
  admitted: "admitted-request",
  runState: "run-state",
  terminal: "terminal",
};

/** One whole-page section as the last state.jsonl row of its kind says (`{}` when absent). */
export function readStatePage(runDirectory: string, section: CurrentSection): Record<string, unknown> {
  return statePayloads<Record<string, unknown>>(runDirectory, PAGE_ROW_KIND[section]).at(-1) ?? {};
}

/**
 * Seed (replace) one whole-page section: one state.jsonl row, appended raw as the
 * appender writes it. Creates the run directory.
 */
export function seedStatePage(
  runDirectory: string,
  section: CurrentSection,
  value: Record<string, unknown>,
): void {
  mkdirSync(runDirectory, { recursive: true });
  appendFileSync(
    join(runDirectory, "state.jsonl"),
    `${JSON.stringify({ level: "event", kind: PAGE_ROW_KIND[section], identity: randomUUID(), timestamp: new Date().toISOString(), host: "pi", source: "test-seed", payload: value })}\n`,
    "utf8",
  );
}

/**
 * Seed the leg's terminal page (`{face, at, body}`), as settlement writes it. A
 * `report` face exists only in books written before #1299, which the analyst still reads.
 */
export function seedTerminal(
  runDirectory: string,
  face: "report" | "error" | "no_receipt",
  body: unknown,
): void {
  seedStatePage(runDirectory, "terminal", { face, at: "2026-08-01T00:00:00.000Z", body });
}

/** Remove one whole-page section (a leg that never reached it): its rows go. */
export function clearStatePage(runDirectory: string, section: CurrentSection): void {
  const kind = PAGE_ROW_KIND[section];
  const statePath = join(runDirectory, "state.jsonl");
  if (!existsSync(statePath)) return;
  const kept = readFileSync(statePath, "utf8").split("\n").filter((line) => {
    if (line.trim() === "") return false;
    try { return (JSON.parse(line) as { kind?: unknown }).kind !== kind; } catch { return true; }
  });
  writeFileSync(statePath, kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
}

/**
 * One JSONL volume beside a run: ENOENT → `[]`; other IO and JSON.parse throw.
 * Sole rule for history / state / log fixture reads (#1161 T1) — not a production hook.
 */
function readRunJsonlRows(runDirectory: string, fileName: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(runDirectory, fileName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every line of `<run>/history.jsonl`, parsed raw (`[]` when absent). */
export function readHistoryRows(runDirectory: string): Record<string, unknown>[] {
  return readRunJsonlRows(runDirectory, "history.jsonl");
}

/** The `payload` of every history.jsonl row of one kind, in append order. */
export function historyPayloads<T = Record<string, unknown>>(runDirectory: string, kind: string): T[] {
  return readHistoryRows(runDirectory).filter((row) => row.kind === kind).map((row) => row.payload as T);
}

/** Every line of `<run>/state.jsonl` (the four whole-page fact rows), parsed raw (`[]` when absent). */
export function readStateRows(runDirectory: string): Record<string, unknown>[] {
  return readRunJsonlRows(runDirectory, "state.jsonl");
}

/** The `payload` of every state.jsonl row of one kind, in append order. */
export function statePayloads<T = Record<string, unknown>>(runDirectory: string, kind: string): T[] {
  return readStateRows(runDirectory).filter((row) => row.kind === kind).map((row) => row.payload as T);
}

/**
 * Every line of `<run>/log.jsonl`, parsed raw (`[]` when absent), optionally
 * only rows of one `kind` (host stderr, dispatch-error, post-admission-diagnostic,
 * resume-diagnostic, host-session, ...). Each row's content is its `payload`.
 */
export function readRunLogRows(runDirectory: string, kind?: string): Record<string, unknown>[] {
  const rows = readRunJsonlRows(runDirectory, "log.jsonl");
  return kind === undefined ? rows : rows.filter((row) => row.kind === kind);
}

/**
 * Bind a host's native session id the way a host does: one `host-session-id`
 * row appended to the run's state.jsonl through the real appender.
 */
export function seedHostSessionId(runDirectory: string, host: string, sessionId: unknown): void {
  mkdirSync(runDirectory, { recursive: true });
  reportRunRecord(runDirectory, "host-session-id", { host, sessionId }, "test-fixture");
}

/** The `payload` of every log row of one kind, in append order. */
export function runLogPayloads<T = Record<string, unknown>>(runDirectory: string, kind: string): T[] {
  return readRunLogRows(runDirectory, kind).map((row) => row.payload as T);
}

/**
 * Package faults noted beside a kept conclusion in one session file, in append order.
 * Only those lines are parsed: a session may hold malformed lines of its own.
 */
export function sessionFaultNotes(sessionFile: string): { diagnostic?: unknown }[] {
  return readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.includes(POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE))
    .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } })
    .flatMap((entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE ? [entry.data ?? {}] : []);
}

/** The originals named by this leg's seals, in order. */
export function submittedParams(runDirectory: string): unknown[] {
  return historyPayloads<{ receipt: string }>(runDirectory, "sealed").map(({ receipt }) =>
    JSON.parse(readFileSync(join(runDirectory, "../..", receipt), "utf8")));
}

/**
 * The body of the terminal row an error / no_receipt pointer names: the last
 * `terminal` row of that file (the run's state.jsonl), after checking the face.
 */
export function terminalBodyAt(
  statePath: string,
  face: "error" | "no_receipt",
): Record<string, unknown> {
  assert.equal(basename(statePath), "state.jsonl", `terminal pointer is the run's state.jsonl: ${statePath}`);
  const terminal = statePayloads<{ face?: string; at?: unknown; body?: Record<string, unknown> }>(dirname(statePath), "terminal").at(-1);
  assert.equal(terminal?.face, face);
  assert.equal(typeof terminal?.at, "string");
  return terminal!.body!;
}

/**
 * The receipts a settled terminal's report artifacts open (#1299): each report path is
 * one of the terminal's own `receipts` rows, in the same order.
 */
export function reportedReceipts(terminal: {
  readonly artifacts: readonly { readonly kind: string; readonly path: string }[];
  readonly receipts?: readonly { readonly receipt: string }[];
}): unknown[] {
  const reports = terminal.artifacts.filter((artifact) => artifact.kind === "report").map((artifact) => artifact.path);
  assert.deepEqual(reports, (terminal.receipts ?? []).map((row) => row.receipt));
  return reports.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/**
 * #1161 / #1165 / #1199: bound-at-rest leaf names after accepted seal
 * (dossier + leg-local `receipts/` / `session/`). Sole list of the four;
 * allowlist below spreads this and adds unbound / seat-only leaves.
 */
export const RUN_DIRECTORY_BOUND_AT_REST_ENTRIES = [
  "history.jsonl",
  "receipts",
  "session",
  "state.jsonl",
] as const;

/**
 * Leaf names a run directory may hold at rest: bound four plus `log.jsonl` (only
 * once the leg has a log row), unbound staging `progress.jsonl` and seat input
 * `merger-input.json`.
 * `--attach` / `--request-manifest` leave only caller paths in the admitted record.
 */
export const RUN_DIRECTORY_ALLOWED_ENTRIES = [
  ...RUN_DIRECTORY_BOUND_AT_REST_ENTRIES,
  "log.jsonl",
  "progress.jsonl",
  "merger-input.json",
] as const;

export function assertRunDirectoryHoldsOnlyDossier(runDirectory: string): void {
  const allowed = new Set<string>(RUN_DIRECTORY_ALLOWED_ENTRIES);
  for (const entry of readdirSync(runDirectory)) {
    assert.equal(allowed.has(entry), true, `unexpected run directory entry: ${entry}`);
  }
}

/**
 * Make every later page write of `<run>/state.jsonl` fail (EACCES on append) while
 * reads still work: the file's own mode refuses the append.
 */
export function lockStateRows(runDirectory: string): void {
  chmodSync(join(runDirectory, "state.jsonl"), 0o444);
}

/** Undo lockStateRows. */
export function unlockStateRows(runDirectory: string): void {
  chmodSync(join(runDirectory, "state.jsonl"), 0o644);
}
