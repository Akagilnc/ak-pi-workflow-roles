/**
 * #836: officers receive the whole run directory pointer and find materials
 * themselves — no code preference for a gate leaf over session.jsonl (A7.2).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { createAuditorDossierTool } from "../../src/auditor-dossier-tool.ts";

function headerOnlySession(runDirectory: string): string {
  const sessionFile = join(runDirectory, "session", "session.jsonl");
  mkdirSync(join(runDirectory, "session"), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "header-only",
      timestamp: new Date().toISOString(),
      cwd: runDirectory,
    })}\n`,
    "utf8",
  );
  return sessionFile;
}

test("dossier locator points at whole run directory session, not a preferred leaf (#836)", async () => {
  await withTempRoot("ak-gate-dossier-", async (runDirectory) => {
    const sessionFile = headerOnlySession(runDirectory);
    const located = await createAuditorDossierTool(runDirectory).execute("id", {});
    assert.equal(located.details?.runDirectory, runDirectory);
    assert.equal(located.details?.parentSessionCandidate, sessionFile);
    assert.equal(
      located.details !== undefined && "submissionCandidate" in located.details,
      false,
    );
  });
});
