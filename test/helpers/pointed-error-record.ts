import { readdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

/**
 * The error record a run handed its caller, located the way the caller would
 * locate it: by the pointer in the run's stderr, not by a path the test already
 * knows. Reading a test-known path proves only that the artifact persisted, not
 * that the failure was delivered.
 */
export async function pointedErrorRecordPath(
  runDirectory: string,
  stderr: string,
): Promise<string> {
  const directory = join(runDirectory, "artifacts");
  const candidates = await readdir(directory);
  const pointed = candidates
    .map((name) => join(directory, name))
    .find((path) => stderr.includes(path));
  assert.ok(
    pointed,
    `resume must point at its error record: ${stderr} (artifacts: ${candidates.join(", ")})`,
  );
  return pointed;
}
