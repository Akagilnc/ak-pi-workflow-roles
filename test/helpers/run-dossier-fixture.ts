/**
 * Raw `current.json` access for tests (docs/dossier-topology.md, #1161).
 * Independent of src/run-dossier.ts on purpose: tests assert on the bytes a
 * reader outside the package would see, and seed fixtures without the
 * production writer.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { reportRunRecord } from "../../src/sitian-facade.ts";

export type CurrentSectionName = "invocation" | "admitted" | "runState" | "host" | "delivery" | "submission" | "terminal" | "officers";

/** Parsed `<run>/current.json`; `{}` when absent. */
export function readCurrentJson(runDirectory: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(runDirectory, "current.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** One section of `<run>/current.json` (`{}` when absent). */
export function readCurrentSection(
  runDirectory: string,
  section: CurrentSectionName,
): Record<string, unknown> {
  return (readCurrentJson(runDirectory)[section] ?? {}) as Record<string, unknown>;
}

/** Seed (replace) one section, keeping the others. Creates the run directory. */
export function seedCurrentSection(
  runDirectory: string,
  section: CurrentSectionName,
  value: Record<string, unknown>,
): void {
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(
    join(runDirectory, "current.json"),
    `${JSON.stringify({ ...readCurrentJson(runDirectory), [section]: value }, null, 2)}\n`,
    "utf8",
  );
}

/** Seed the leg's terminal section (`{face, at, body}`), as settlement writes it. */
export function seedTerminal(
  runDirectory: string,
  face: "report" | "error" | "no_receipt",
  body: unknown,
): void {
  seedCurrentSection(runDirectory, "terminal", { face, at: "2026-08-01T00:00:00.000Z", body });
}

/** Remove one section, keeping the others (a leg that never reached it). */
export function clearCurrentSection(runDirectory: string, section: CurrentSectionName): void {
  const { [section]: _removed, ...rest } = readCurrentJson(runDirectory);
  writeFileSync(join(runDirectory, "current.json"), `${JSON.stringify(rest, null, 2)}\n`, "utf8");
}

/** Every line of `<run>/history.jsonl`, parsed raw (`[]` when absent). */
export function readHistoryRows(runDirectory: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(runDirectory, "history.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The `payload` of every history.jsonl row of one kind, in append order. */
export function historyPayloads<T = Record<string, unknown>>(runDirectory: string, kind: string): T[] {
  return readHistoryRows(runDirectory).filter((row) => row.kind === kind).map((row) => row.payload as T);
}

/**
 * Every line of `<run>/log.jsonl`, parsed raw (`[]` when absent), optionally
 * only rows of one `kind` (host stderr, dispatch-error, post-admission-diagnostic,
 * resume-diagnostic, host-session, ...). Each row's content is its `payload`.
 */
export function readRunLogRows(runDirectory: string, kind?: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(runDirectory, "log.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows = raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  return kind === undefined ? rows : rows.filter((row) => row.kind === kind);
}

/**
 * Bind a host's native session id the way a host does: one `host-session-id`
 * row appended to the run's log.jsonl through the real appender. `current.json`
 * `host` is derived from these rows on the next write, so it cannot be seeded.
 */
export function seedHostSessionId(runDirectory: string, host: string, sessionId: unknown): void {
  mkdirSync(runDirectory, { recursive: true });
  reportRunRecord(runDirectory, "host-session-id", { host, sessionId }, "test-fixture");
}

/** The `payload` of every log row of one kind, in append order. */
export function runLogPayloads<T = Record<string, unknown>>(runDirectory: string, kind: string): T[] {
  return readRunLogRows(runDirectory, kind).map((row) => row.payload as T);
}

/** What the role submitted and had accepted, in order: `accepted` of every `sealed` row in history.jsonl. */
export function submittedParams(runDirectory: string): unknown[] {
  return historyPayloads<{ accepted?: unknown }>(runDirectory, "sealed").map((payload) => payload.accepted);
}

/**
 * The body of the terminal section a `TerminalArtifactRef.path` (the run's
 * current.json) names, after checking the face.
 */
export function terminalBodyAt(
  currentJsonPath: string,
  face: "report" | "error" | "no_receipt",
): Record<string, unknown> {
  assert.equal(currentJsonPath.endsWith("current.json"), true, `artifact ref is the run's current.json: ${currentJsonPath}`);
  const terminal = readCurrentJson(dirname(currentJsonPath)).terminal as
    { face?: string; at?: unknown; body?: Record<string, unknown> } | undefined;
  assert.equal(terminal?.face, face);
  assert.equal(typeof terminal?.at, "string");
  return terminal!.body!;
}

/**
 * #1161: a run at rest carries none of the retired dossier files — no
 * artifacts/, stderr.log, start-up input files, per-page json, `.run-starts`
 * — and its session/ holds no numbered host copies, staging leftovers,
 * failed-copy markers, session-binding files or sitian volume for host-session.
 */
export function assertNoRetiredDossierFiles(runDirectory: string): void {
  for (const name of [
    "artifacts", "stderr.log", "headless-system-prompt.txt", "headless-output-schema.json",
    "headless-mcp-config.json", "run-state.json", "invocation.json", "admitted-request.json", ".run-starts",
  ]) {
    assert.equal(existsSync(join(runDirectory, name)), false, `retired dossier file present: ${name}`);
  }
  const sessionDirectory = join(runDirectory, "session");
  if (!existsSync(sessionDirectory)) return;
  for (const entry of readdirSync(sessionDirectory)) {
    assert.equal(
      /-\d+(\.jsonl|\.failed)?$|\.copying$|-(headless|acp)-session\.json$|^host-session$|^submission-ledger$|^attempt-history$|^auditor-roles$/.test(entry),
      false,
      `retired session entry present: ${entry}`,
    );
  }
}

/**
 * Make every later write of `<run>/current.json` fail: the file is read-only and the
 * directory takes no new entries (current.json is replaced atomically through a
 * temp file, with an in-place fallback only when that is refused).
 */
export function lockCurrentJson(runDirectory: string): void {
  chmodSync(join(runDirectory, "current.json"), 0o444);
  chmodSync(runDirectory, 0o500);
}

/** Undo lockCurrentJson. */
export function unlockCurrentJson(runDirectory: string): void {
  chmodSync(runDirectory, 0o755);
  chmodSync(join(runDirectory, "current.json"), 0o644);
}
