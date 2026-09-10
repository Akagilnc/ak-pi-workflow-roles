/**
 * #836: officers receive the whole run directory pointer and find materials
 * themselves — no code preference for a gate leaf over session.jsonl (A7.2).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import {
  createAuditorDossierTool,
  readLatestToolCallLeaf,
} from "../../src/auditor-dossier-tool.ts";

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
    const located = await createAuditorDossierTool(runDirectory, {
      submissionCandidate: join(runDirectory, "artifacts", "gate-submission-candidate.json"),
    }).execute("id", {});
    assert.equal(located.details?.runDirectory, runDirectory);
    assert.equal(located.details?.parentSessionCandidate, sessionFile);
    assert.equal(located.details?.submissionCandidate, undefined);
  });
});

test("readLatestToolCallLeaf still returns the last assistant toolCall entry (helper retained)", async () => {
  const older = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "ak_fixer_output", arguments: { status: "old" } }],
    },
  };
  const newer = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "2", name: "ak_fixer_output", arguments: { status: "new" } }],
    },
  };
  const found = readLatestToolCallLeaf({
    sessionManager: {
      getEntries: () => [
        { type: "message", message: { role: "user", content: "hi" } },
        older,
        { type: "message", message: { role: "toolResult", content: [] } },
        newer,
      ],
    },
  });
  assert.deepEqual(found, newer);
});
