import assert from "node:assert/strict";
import { join } from "node:path";

import { runLogPayloads, terminalBodyAt } from "./run-dossier-fixture.ts";

/**
 * The error record a run handed its caller, located the way the caller would
 * locate it: by the pointer in the run's stderr, not by a path the test already
 * knows, then read. The pointer names either the run's log.jsonl (a failure
 * before any host turn: the record is its latest resume-diagnostic row) or the
 * run's current.json (a controlled failure: the error is its terminal section).
 * Reading a test-known path proves only that the failure persisted, not that it
 * was delivered.
 */
export async function pointedErrorRecord(
  runDirectory: string,
  stderr: string,
): Promise<Record<string, unknown>> {
  const current = join(runDirectory, "current.json");
  if (stderr.includes(current)) return terminalBodyAt(current, "error");
  const log = join(runDirectory, "log.jsonl");
  assert.ok(stderr.includes(log), `resume must point at its error record: ${stderr}`);
  const diagnostics = runLogPayloads(runDirectory, "resume-diagnostic");
  assert.ok(diagnostics.length > 0, `the pointed log carries a resume-diagnostic row: ${log}`);
  return diagnostics[diagnostics.length - 1]!;
}
