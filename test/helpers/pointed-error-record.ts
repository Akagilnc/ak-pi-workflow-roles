import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

import { terminalBodyAt } from "./run-dossier-fixture.ts";

/**
 * The error record a run handed its caller, located the way the caller would
 * locate it: by the pointer in the run's stderr, not by a path the test already
 * knows, then read. The pointer names either a resume-diagnostic file under the
 * run's artifacts/ (a failure before any host turn) or the run's current.json
 * (a controlled failure: the error is its terminal section). Reading a
 * test-known path proves only that the failure persisted, not that it was
 * delivered.
 */
export async function pointedErrorRecord(
  runDirectory: string,
  stderr: string,
): Promise<Record<string, unknown>> {
  const current = join(runDirectory, "current.json");
  if (stderr.includes(current)) return terminalBodyAt(current, "error");
  const directory = join(runDirectory, "artifacts");
  const candidates = await readdir(directory).catch(() => [] as string[]);
  const pointed = candidates.map((name) => join(directory, name)).find((path) => stderr.includes(path));
  assert.ok(
    pointed,
    `resume must point at its error record: ${stderr} (artifacts: ${candidates.join(", ")})`,
  );
  return JSON.parse(await readFile(pointed, "utf8")) as Record<string, unknown>;
}
