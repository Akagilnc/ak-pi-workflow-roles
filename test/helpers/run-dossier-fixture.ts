/**
 * Raw `current.json` access for tests (docs/dossier-topology.md, #1161).
 * Independent of src/run-dossier.ts on purpose: tests assert on the bytes a
 * reader outside the package would see, and seed fixtures without the
 * production writer.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CurrentSectionName = "invocation" | "admitted" | "runState" | "host" | "delivery" | "submission" | "officers";

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
