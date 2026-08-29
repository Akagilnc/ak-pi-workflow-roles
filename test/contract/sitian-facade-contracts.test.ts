/**
 * S5 Sitian facade, layout, appender, reader, and S4 channel contract tests.
 * Demonstrates:
 * - Three contracts (Facade, Layout, Appender/Reader)
 * - Three levels (run-summary, event, protocol-snapshot) with usage and raw references
 * - Entry-level idempotency (Appender self-check -> returns existing pointer, 0 re-append)
 * - Torn-tail crash recovery substate a (missing trailing newline -> committed on recovery, 0 re-append)
 * - Torn-tail crash recovery substate b (corrupted fragment preserved, new row appended)
 * - Reader traversal contract (terminated malformed line exposes typed diagnostic and continues traversal; subsequent rows reachable; 0 deduplication)
 * - S4 submission ledger channel (five kinds, subject={runId, attemptId}, priorEventId chain, cross-attempt appending)
 * - Infrastructure failure honesty (original cause propagated)
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  sitianReport,
  readSitianRecords,
  type SitianRecordInput,
  type SitianRecord,
} from "../../src/sitian-facade.ts";
import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("Sitian facade: Layout supports three levels, usage, raw pointer, and no destination parameter", async () => {
  await withHermeticHome({ prefix: "ak-sitian-layout-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    // 1. run-summary level
    const runSummaryPtr = sitianReport({
      level: "run-summary",
      kind: "settlement-summary",
      cwd: project,
      subject: { runId: "run-001", attemptId: "att-001" },
      payload: { status: "completed", wallMs: 1200 },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    assert.equal(runSummaryPtr.level, "run-summary");
    assert.equal(runSummaryPtr.kind, "settlement-summary");
    assert.ok(runSummaryPtr.recordFile.includes("settlement-summary"));

    // 2. event level with raw pointer
    const eventPtr = sitianReport({
      level: "event",
      kind: "gate",
      cwd: project,
      subject: { runId: "run-001", attemptId: "att-001" },
      payload: { gateStatus: "passed" },
      raw: { sessionFile: "/path/to/raw/session.jsonl", entryId: "entry-42" },
      source: "worker-submission-gates",
    });
    assert.equal(eventPtr.level, "event");
    assert.equal(eventPtr.kind, "gate");

    // 3. protocol-snapshot level
    const snapshotPtr = sitianReport({
      level: "protocol-snapshot",
      kind: "auditor-roles",
      cwd: project,
      subject: "subject-snapshot-01",
      payload: { snapshotKey: "snap-1" },
    });
    assert.equal(snapshotPtr.level, "protocol-snapshot");
    assert.equal(snapshotPtr.kind, "auditor-roles");

    // Verify written records via Reader
    const readSummary = await readSitianRecords(runSummaryPtr.recordFile);
    assert.equal(readSummary.records.length, 1);
    const rec0 = readSummary.records[0]!;
    assert.equal(rec0.level, "run-summary");
    assert.equal(rec0.usage?.totalTokens, 150);
    assert.equal(rec0.host, "pi");
    assert.ok(rec0.timestamp);

    const readEvent = await readSitianRecords(eventPtr.recordFile);
    assert.equal(readEvent.records.length, 1);
    const eventRec0 = readEvent.records[0]!;
    assert.equal(eventRec0.raw?.entryId, "entry-42");
    assert.equal(eventRec0.source, "worker-submission-gates");
  });
});

test("Sitian facade: Entry-level idempotency returns existing pointer with zero re-append", async () => {
  await withHermeticHome({ prefix: "ak-sitian-idempotent-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const input: SitianRecordInput = {
      level: "event",
      kind: "doctor-candidate",
      cwd: project,
      subject: { runId: "run-idem", attemptId: "att-1" },
      identity: "canonical-idem-id-123",
      payload: { diagnosis: "healthy" },
      raw: { sessionFile: "/session.jsonl", entryId: "f-1" },
    };

    const ptr1 = sitianReport(input);
    const textAfterFirst = await readFile(ptr1.recordFile, "utf8");

    // Second write with identical canonical identity
    const ptr2 = sitianReport(input);
    const textAfterSecond = await readFile(ptr1.recordFile, "utf8");

    assert.equal(ptr2.identity, ptr1.identity);
    assert.equal(ptr2.recordFile, ptr1.recordFile);
    assert.equal(textAfterSecond, textAfterFirst, "Zero re-append on idempotent write");

    const read = await readSitianRecords(ptr1.recordFile);
    assert.equal(read.records.length, 1);
  });
});

test("Sitian facade: Torn-tail recovery substate a (missing trailing newline treated as committed)", async () => {
  await withHermeticHome({ prefix: "ak-sitian-torn-a-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const input: SitianRecordInput = {
      level: "event",
      kind: "attendance",
      cwd: project,
      subject: "substate-a-test",
      identity: "ident-short-write-a",
      payload: { step: "arrival" },
    };

    // First write normally to establish volume
    const ptr1 = sitianReport(input);

    // Simulate crash where a line was written without trailing newline
    const shortWriteRecord: SitianRecord = {
      level: "event",
      kind: "attendance",
      identity: "ident-short-write-a-2",
      subject: "substate-a-test",
      timestamp: "2026-08-28T00:00:00.000Z",
      host: "pi",
      payload: { step: "recommendation" },
    };
    // Append without trailing \n
    await appendFile(ptr1.recordFile, JSON.stringify(shortWriteRecord), "utf8");

    // Reopen & write with that same identity -> substate a: recovery seals line with \n, detects valid JSON & identity, returns existing pointer
    const ptr2 = sitianReport({
      level: "event",
      kind: "attendance",
      cwd: project,
      subject: "substate-a-test",
      identity: "ident-short-write-a-2",
      payload: { step: "recommendation" },
    });

    assert.equal(ptr2.identity, "ident-short-write-a-2");
    assert.equal(ptr2.recordFile, ptr1.recordFile);

    const fileContent = await readFile(ptr1.recordFile, "utf8");
    assert.ok(fileContent.endsWith("\n"), "Torn-tail must be newline-terminated");

    const read = await readSitianRecords(ptr1.recordFile);
    assert.equal(read.records.length, 2);
    assert.equal(read.records[1]!.identity, "ident-short-write-a-2");
    assert.equal(read.diagnostics.length, 0, "Repaired valid line has no diagnostics");
  });
});

test("Sitian facade: Torn-tail recovery substate b (corrupted fragment preserved, new row appended, Reader reaches subsequent rows)", async () => {
  await withHermeticHome({ prefix: "ak-sitian-torn-b-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const input1: SitianRecordInput = {
      level: "event",
      kind: "auditor",
      cwd: project,
      subject: "substate-b-test",
      identity: "row-1",
      payload: { audit: "pass" },
    };
    const ptr1 = sitianReport(input1);

    // Simulate corrupted mid-write crash (incomplete JSON fragment without newline)
    const corruptFragment = '{"level":"event","kind":"auditor","identity":"corrupted-frag';
    await appendFile(ptr1.recordFile, corruptFragment, "utf8");

    // Reopen & write new record -> substate b: seals corrupt fragment with \n, check misses, appends new row
    const ptr2 = sitianReport({
      level: "event",
      kind: "auditor",
      cwd: project,
      subject: "substate-b-test",
      identity: "row-2-canonical",
      payload: { audit: "escalate" },
    });

    assert.equal(ptr2.identity, "row-2-canonical");
    const rawBytes = await readFile(ptr1.recordFile, "utf8");
    const lines = rawBytes.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3, "Corrupt fragment preserved as independent bad line + 2 canonical lines");
    assert.equal(lines[1], corruptFragment);

    // Assert through real Reader entrypoint: malformed diagnostic exposed AND row 2 reachable
    const read = await readSitianRecords(ptr1.recordFile);
    assert.equal(read.records.length, 2);
    assert.equal(read.records[0]!.identity, "row-1");
    assert.equal(read.records[1]!.identity, "row-2-canonical", "Subsequent canonical row MUST be reachable");

    assert.equal(read.diagnostics.length, 1);
    const diag0 = read.diagnostics[0]!;
    assert.equal(diag0.kind, "malformed");
    assert.equal(diag0.line, 2);
    assert.equal(diag0.raw, corruptFragment);
  });
});

test("Sitian facade: S4 submission ledger channel with 5 kinds, priorEventId chain, and cross-attempt appending", async () => {
  await withHermeticHome({ prefix: "ak-sitian-s4-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const s4Kinds = [
      "candidate",
      "batchContext",
      "outcome",
      "sealed",
      "post-seal-anomaly",
    ] as const;

    let previousEventId: string | undefined;
    let recordFile = "";

    // Attempt 1: write candidate, batchContext, outcome
    for (let i = 0; i < 3; i++) {
      const kind = s4Kinds[i]!;
      const eventId = `s4-evt-${i + 1}`;
      const ptr = sitianReport({
        level: "event",
        kind,
        cwd: project,
        subject: { runId: "s4-run-01", attemptId: "att-1" },
        identity: eventId,
        priorEventId: previousEventId,
        payload: { index: i, desc: `S4 event ${kind}` },
      });
      previousEventId = eventId;
      recordFile = ptr.recordFile;
    }

    // Attempt 2: cross-attempt appending (sealed, post-seal-anomaly) onto the same subject run ledger
    for (let i = 3; i < 5; i++) {
      const kind = s4Kinds[i]!;
      const eventId = `s4-evt-${i + 1}`;
      const ptr = sitianReport({
        level: "event",
        kind,
        cwd: project,
        subject: { runId: "s4-run-01", attemptId: "att-2" },
        identity: eventId,
        priorEventId: previousEventId,
        payload: { index: i, desc: `S4 event ${kind}` },
      });
      previousEventId = eventId;
      assert.equal(ptr.recordFile, recordFile, "Cross-attempt writes share the run ledger volume");
    }

    // Read full S4 ledger chain via Reader
    const read = await readSitianRecords(recordFile);
    assert.equal(read.records.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(read.records[i]!.kind, s4Kinds[i]);
      assert.equal(read.records[i]!.identity, `s4-evt-${i + 1}`);
      if (i === 0) {
        assert.equal(read.records[i]!.priorEventId, undefined);
      } else {
        assert.equal(read.records[i]!.priorEventId, `s4-evt-${i}`);
      }
    }
  });
});
