/**
 * ADR 0086 Boundary Tracers:
 * 1. Duplicate processing tracer:
 *    Same raw session processed twice via Pi adapter/facade ->
 *    - Second run returns deterministic RecordPointers
 *    - Reader reads records across passes (Log4j append-only appends unconditionally)
 *    - Raw session file is untouched
 * 2. Normalization failure negative case:
 *    - Unparseable frame -> raw preserved, typed normalization-failure recorded, does not abort.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  normalizePiSessionAttempt,
} from "../../src/pi/pi-normalization.ts";
import { readSitianRecords, sitianReport } from "../../src/sitian-facade.ts";
import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("Boundary Tracer 1: Duplicate processing of raw session under log4j append-only appends both passes while raw session untouched", async () => {
  await withHermeticHome({ prefix: "ak-tracer-dup-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionFile = join(home, ".ak-roles/books/proj/runs/run-dup-1/session/session.jsonl");
    await mkdir(dirname(sessionFile), { recursive: true });
    const rawContent = [
      JSON.stringify({ type: "session", id: "sess-dup-001", timestamp: "2026-08-28T01:00:00.000Z", cwd: project }),
      JSON.stringify({ type: "model_change", modelId: "gemini-2.5-pro", timestamp: "2026-08-28T01:00:01.000Z" }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        timestamp: "2026-08-28T01:00:02.000Z",
        message: {
          role: "assistant",
          model: "gemini-2.5-pro",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hello\nworld" } }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        timestamp: "2026-08-28T01:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "hello\nworld" }],
          isError: false,
        },
      }),
    ].join("\n") + "\n";

    await writeFile(sessionFile, rawContent, "utf8");

    // First normalization pass
    const pointers1 = await normalizePiSessionAttempt({
      sessionFile,
      cwd: project,
      home,
      subject: { runId: "run-dup-1", attemptId: "att-1" },
    });
    assert.equal(pointers1.length, 2, "Produces tool-call and attempt summary pointers");

    const rawAfterFirst = await readFile(sessionFile, "utf8");
    assert.equal(rawAfterFirst, rawContent, "Raw session must be untouched (#513 dual persistence)");

    // Second normalization pass (representing resume / re-process)
    const pointers2 = await normalizePiSessionAttempt({
      sessionFile,
      cwd: project,
      home,
      subject: { runId: "run-dup-1", attemptId: "att-1" },
    });

    assert.equal(pointers2.length, pointers1.length);
    for (let i = 0; i < pointers1.length; i++) {
      assert.equal(pointers2[i]!.identity, pointers1[i]!.identity, "Identities match deterministically");
      assert.equal(pointers2[i]!.recordFile, pointers1[i]!.recordFile, "Record files match");
    }

    const rawAfterSecond = await readFile(sessionFile, "utf8");
    assert.equal(rawAfterSecond, rawContent, "Raw session still untouched");

    // Read canonical volume for tool-call via Reader: append-only appends each pass under ADR 0086
    const readTool = await readSitianRecords(pointers1[0]!.recordFile);
    assert.equal(readTool.records.length, 2, "Append-only tool-call records across two passes");
    assert.equal(readTool.records[0]!.identity, "sess-dup-001:call-1");

    // Read canonical volume for summary via Reader: append-only appends each pass
    const readSummary = await readSitianRecords(pointers1[1]!.recordFile);
    assert.equal(readSummary.records.length, 2, "Append-only summary records across two passes");
    assert.equal(readSummary.records[0]!.identity, "sess-dup-001:summary");
  });
});

test("Normalization failure negative case: unparseable session frame produces normalization-failure without aborting", async () => {
  await withHermeticHome({ prefix: "ak-norm-fail-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionFile = join(home, ".ak-roles/books/proj/runs/run-bad/session/session.jsonl");
    await mkdir(dirname(sessionFile), { recursive: true });
    const content = [
      JSON.stringify({ type: "session", id: "sess-bad-frame", timestamp: "2026-08-28T01:00:00.000Z", cwd: project }),
      "THIS IS NOT VALID JSON",
      JSON.stringify({
        type: "message",
        id: "msg-valid-1",
        timestamp: "2026-08-28T01:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-3-opus",
          content: [{ type: "toolCall", id: "call-2", name: "git", arguments: { command: "git status" } }],
        },
      }),
    ].join("\n") + "\n";

    await writeFile(sessionFile, content, "utf8");

    // Should NOT throw/abort; instead records typed normalization-failure and keeps raw
    const pointers = await normalizePiSessionAttempt({
      sessionFile,
      cwd: project,
      home,
      subject: { runId: "run-bad-1" },
    });

    const normFailPointer = pointers.find((p) => p.kind === "normalization-failure");
    assert.ok(normFailPointer, "Must return normalization-failure pointer");
    const readFail = await readSitianRecords(normFailPointer.recordFile);
    assert.equal(readFail.records.length, 1);
    assert.equal(readFail.records[0]!.level, "event");
    assert.equal(readFail.records[0]!.raw?.sessionFile, sessionFile);

    const toolPointer = pointers.find((p) => p.kind === "tool-call");
    assert.ok(toolPointer, "Must return tool-call pointer");
    const readTool = await readSitianRecords(toolPointer.recordFile);
    assert.equal(readTool.records.length, 1);
    assert.equal(readTool.records[0]!.raw?.entryId, "call-2");
  });
});
