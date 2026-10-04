import assert from "node:assert/strict";
import { join } from "node:path";

import { runLogPayloads, terminalBodyAt } from "./run-dossier-fixture.ts";

/**
 * The structured failure record a resume left for its caller.
 * Controlled failures land in current.json `terminal` (face=error);
 * pre-host resume failures land as the latest `resume-diagnostic` in log.jsonl.
 * Delivery of a stderr pointer is a human-facing hint — observed on real runs,
 * not selected by tests via free-text matching (#1161 T2 / #1058).
 */
export async function pointedErrorRecord(
  runDirectory: string,
): Promise<Record<string, unknown>> {
  const current = join(runDirectory, "current.json");
  try {
    return terminalBodyAt(current, "error");
  } catch {
    // No terminal error face — fall through to pre-host diagnostic rows.
  }
  const diagnostics = runLogPayloads(runDirectory, "resume-diagnostic");
  assert.ok(
    diagnostics.length > 0,
    `run must carry a structured failure record: ${runDirectory}`,
  );
  return diagnostics[diagnostics.length - 1]!;
}
