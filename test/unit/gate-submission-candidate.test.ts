import { testTmpdir } from "../helpers/worktree-temp.ts";
/**
 * #632: Grok host session.jsonl is header-only (#617 DK-4). After pointer-only
 * summons deleted subject.material, gate officers must still resolve the
 * in-flight tool-call leaf via a run-directory artifact.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createAuditorDossierTool,
  gateSubmissionCandidatePath,
  persistGateSubmissionCandidate,
  readLatestToolCallLeaf,
} from "../../src/auditor-dossier-tool.ts";

const MARKER = "GATE-CANDIDATE-BODY-MARKER-632";

function headerOnlySession(runDirectory: string): string {
  const sessionFile = join(runDirectory, "session", "session.jsonl");
  mkdirSync(join(runDirectory, "session"), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "grok-header-only",
      timestamp: new Date().toISOString(),
      cwd: runDirectory,
    })}\n`,
    "utf8",
  );
  return sessionFile;
}

function memoryToolCallLeaf(args: Record<string, unknown>) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-gate-1",
          name: "ak_fixer_output",
          arguments: args,
        },
      ],
    },
  };
}

test("persistGateSubmissionCandidate writes memory tool-call leaf to run artifact", () => {
  const runDirectory = mkdtempSync(join(testTmpdir(), "ak-gate-candidate-"));
  headerOnlySession(runDirectory);
  const leaf = memoryToolCallLeaf({ status: "completed", report: MARKER });
  const context = {
    sessionManager: {
      getEntries: () => [leaf],
    },
  };

  const path = persistGateSubmissionCandidate(runDirectory, context);
  assert.equal(path, gateSubmissionCandidatePath(runDirectory));
  const written = readFileSync(path!, "utf8");
  assert.equal(written.includes(MARKER), true);
  assert.deepEqual(JSON.parse(written), leaf);
});

test("dossier locator prefers persisted leaf over header-only session.jsonl", async () => {
  const runDirectory = mkdtempSync(join(testTmpdir(), "ak-gate-dossier-"));
  const sessionFile = headerOnlySession(runDirectory);
  const leaf = memoryToolCallLeaf({ status: "completed", report: MARKER });
  const path = persistGateSubmissionCandidate(runDirectory, {
    sessionManager: { getEntries: () => [leaf] },
  });
  assert.ok(path);

  const located = await createAuditorDossierTool(runDirectory, {
    submissionCandidate: path,
  }).execute("id", {});
  assert.equal(located.details?.parentSessionCandidate, path);
  assert.equal(located.details?.submissionCandidate, path);
  assert.equal(readFileSync(located.details!.parentSessionCandidate, "utf8").includes(MARKER), true);

  // Header-only durable principal is still on disk but is not the candidate pointer.
  assert.equal(readFileSync(sessionFile, "utf8").includes(MARKER), false);
  assert.equal(readFileSync(sessionFile, "utf8").includes('"type":"session"'), true);
});

test("mutation: without persist, parentSessionCandidate stays header-only (blind)", async () => {
  const runDirectory = mkdtempSync(join(testTmpdir(), "ak-gate-blind-"));
  const sessionFile = headerOnlySession(runDirectory);
  const leaf = memoryToolCallLeaf({ status: "completed", report: MARKER });
  // Leaf only in memory — same Grok booking shape; no artifact write.
  assert.deepEqual(readLatestToolCallLeaf({ sessionManager: { getEntries: () => [leaf] } }), leaf);

  // Old locator shape: session.jsonl only (pre-#632-r2 / material-deleted blind path).
  const located = await createAuditorDossierTool(runDirectory).execute("id", {});
  assert.equal(located.details?.parentSessionCandidate, sessionFile);
  assert.equal(located.details?.submissionCandidate, undefined);
  const pointed = readFileSync(located.details!.parentSessionCandidate, "utf8");
  assert.equal(pointed.includes(MARKER), false, "header-only pointer must not carry candidate body");
  assert.equal(pointed.includes('"type":"session"'), true);
});

test("readLatestToolCallLeaf returns the last assistant toolCall entry", () => {
  const older = memoryToolCallLeaf({ status: "old" });
  const newer = memoryToolCallLeaf({ status: "new", report: MARKER });
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

test("persist returns undefined when session books have no toolCall leaf", () => {
  const runDirectory = mkdtempSync(join(testTmpdir(), "ak-gate-empty-"));
  const path = persistGateSubmissionCandidate(runDirectory, {
    sessionManager: {
      getEntries: () => [{ type: "message", message: { role: "user", content: "only user" } }],
    },
  });
  assert.equal(path, undefined);
});
