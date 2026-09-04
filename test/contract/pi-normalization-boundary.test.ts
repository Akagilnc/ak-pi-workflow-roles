/**
 * #520 S5 Boundary Tracers (B4 acceptance, §4):
 * 1. Duplicate processing tracer:
 *    Same raw session processed twice via Pi adapter/facade ->
 *    - Second run returns same RecordPointers
 *    - Reader reads each canonical record exactly once (zero deduplication in Reader)
 *    - Raw session file is untouched
 * 2. Fault injection tracer (covering both torn-tail substates):
 *    - Substate a (missing trailing \n): reopen + retry -> direct byte assertion:
 *      repaired line is the sole canonical row for this identity, returns existing pointer, 0 duplicate append.
 *    - Substate b (mid-fragment corruption): reopen + retry -> direct byte assertion:
 *      corrupted fragment preserved as independent bad line without loss, zero splicing,
 *      exactly one new canonical row, valid pointer;
 *      AND asserted through real Reader entrypoint: subsequent canonical row is reachable + malformed diagnostic exposed.
 * 3. Normalization failure negative case:
 *    - Unparseable frame -> raw preserved, typed normalization-failure recorded, does not abort.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  normalizePiSessionAttempt,
} from "../../src/pi/pi-normalization.ts";
import { readSitianRecords, sitianReport } from "../../src/sitian-facade.ts";
import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("Boundary Tracer 1: Duplicate processing of raw session returns same pointer and single reader record", async () => {
  await withHermeticHome({ prefix: "ak-tracer-dup-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionFile = join(home, "session.jsonl");
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

    // Read canonical volume for tool-call via Reader: exactly 1 entry (zero deduplication by Reader)
    const readTool = await readSitianRecords(pointers1[0]!.recordFile);
    assert.equal(readTool.records.length, 1, "Zero duplicate tool-call records");
    assert.equal(readTool.records[0]!.identity, "sess-dup-001:call-1");

    // Read canonical volume for summary via Reader: exactly 1 entry
    const readSummary = await readSitianRecords(pointers1[1]!.recordFile);
    assert.equal(readSummary.records.length, 1, "Zero duplicate summary records");
    assert.equal(readSummary.records[0]!.identity, "sess-dup-001:summary");
  });
});

test("Boundary Tracer 2: Fault injection covering both torn-tail substates and Reader reachability", async () => {
  await withHermeticHome({ prefix: "ak-tracer-fault-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    // --- Substate a: genuine short write (complete JSON without trailing newline) ---
    const sessionFileA = join(home, "session-a.jsonl");
    const rawContentA = [
      JSON.stringify({ type: "session", id: "sess-fault-a", timestamp: "2026-08-28T01:00:00.000Z", cwd: project }),
      JSON.stringify({
        type: "message",
        id: "msg-a-1",
        timestamp: "2026-08-28T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-a-1", name: "bash", arguments: { command: "echo test" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-a-2",
        timestamp: "2026-08-28T01:00:03.000Z",
        message: { role: "toolResult", toolCallId: "call-a-1", toolName: "bash", content: [] },
      }),
    ].join("\n") + "\n";
    await writeFile(sessionFileA, rawContentA, "utf8");

    const pointersA1 = await normalizePiSessionAttempt({
      sessionFile: sessionFileA,
      cwd: project,
      home,
      subject: { runId: "run-fault-a" },
    });
    const toolRecordFileA = pointersA1[0]!.recordFile;

    // Simulate incomplete short-write crash
    const shortWriteCanonical = JSON.stringify({
      level: "event",
      kind: "tool-call",
      identity: "sess-fault-a:call-short",
      timestamp: "2026-08-28T01:00:05.000Z",
      host: "pi",
      payload: { toolName: "bash", toolCallId: "call-short" },
    });
    // Write without newline to tool-call volume
    await appendFile(toolRecordFileA, shortWriteCanonical, "utf8");

    // Reopen & process again with that identity
    const ptrRecovered = sitianReport({
      level: "event",
      kind: "tool-call",
      cwd: project,
      home,
      subject: { runId: "run-fault-a" },
      identity: "sess-fault-a:call-short",
      payload: { toolName: "bash", toolCallId: "call-short" },
    });

    assert.equal(ptrRecovered.identity, "sess-fault-a:call-short");
    const rawBytesA = await readFile(toolRecordFileA, "utf8");
    assert.ok(rawBytesA.endsWith("\n"), "Direct byte assertion: repaired line ends with newline");

    const readA = await readSitianRecords(toolRecordFileA);
    const shortRows = readA.records.filter((r) => r.identity === "sess-fault-a:call-short");
    assert.equal(shortRows.length, 1, "Direct byte assertion: repaired line is the sole canonical row for this identity");
    assert.equal(readA.diagnostics.length, 0);

    // --- Substate b: mid-fragment corruption (unparseable fragment without newline) ---
    const sessionFileB = join(home, "session-b.jsonl");
    const rawContentB = [
      JSON.stringify({ type: "session", id: "sess-fault-b", timestamp: "2026-08-28T01:00:00.000Z", cwd: project }),
      JSON.stringify({
        type: "message",
        id: "msg-b-1",
        timestamp: "2026-08-28T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-b-1", name: "bash", arguments: { command: "echo test" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-b-2",
        timestamp: "2026-08-28T01:00:03.000Z",
        message: { role: "toolResult", toolCallId: "call-b-1", toolName: "bash", content: [] },
      }),
    ].join("\n") + "\n";
    await writeFile(sessionFileB, rawContentB, "utf8");

    const pointersB1 = await normalizePiSessionAttempt({
      sessionFile: sessionFileB,
      cwd: project,
      home,
      subject: { runId: "run-fault-b" },
    });
    const toolRecordFileB = pointersB1[0]!.recordFile;

    const corruptedFragment = '{"level":"event","kind":"tool-call","identity":"sess-fault-b:call-bad';
    await appendFile(toolRecordFileB, corruptedFragment, "utf8");

    // Reopen & append new canonical row
    const ptrNext = sitianReport({
      level: "event",
      kind: "tool-call",
      cwd: project,
      home,
      subject: { runId: "run-fault-b" },
      identity: "sess-fault-b:call-after-bad",
      payload: { toolName: "read_file" },
    });

    assert.equal(ptrNext.identity, "sess-fault-b:call-after-bad");

    // Direct byte assertion: corrupted fragment preserved as independent bad line without splicing
    const rawBytesB = await readFile(toolRecordFileB, "utf8");
    const linesB = rawBytesB.split("\n").filter((l) => l.length > 0);
    assert.ok(linesB.includes(corruptedFragment), "Corrupted fragment preserved verbatim as independent bad line");

    // Real Reader entrypoint assertions: malformed diagnostic exposed AND subsequent row reachable
    const readB = await readSitianRecords(toolRecordFileB);
    assert.equal(readB.diagnostics.length, 1);
    assert.equal(readB.diagnostics[0]!.raw, corruptedFragment);
    const subsequentRow = readB.records.find((r) => r.identity === "sess-fault-b:call-after-bad");
    assert.ok(subsequentRow, "Subsequent canonical row is reachable through canonical Reader");
  });
});

test("Normalization failure negative case: unparseable session frame produces normalization-failure without aborting", async () => {
  await withHermeticHome({ prefix: "ak-norm-fail-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionFile = join(home, "bad-frame-session.jsonl");
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
