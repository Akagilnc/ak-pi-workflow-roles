/**
 * Raw `current.json` access for tests (docs/dossier-topology.md, #1161).
 * Independent of src/run-dossier.ts on purpose: tests assert on the bytes a
 * reader outside the package would see, and seed fixtures without the
 * production writer.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** What the role submitted, in order: the `params` of every submission row in history.jsonl. */
export function submittedParams(runDirectory: string): unknown[] {
  return readHistoryRows(runDirectory).filter((row) => row.type === "submission").map((row) => row.params);
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
