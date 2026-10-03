/**
 * S5 Sitian facade, layout, appender, reader, and S4 channel contract tests.
 * Demonstrates:
 * - Three contracts (Facade, Layout, Appender/Reader)
 * - Three levels (run-summary, event, protocol-snapshot) with usage and raw references
 * - Log4j append-only sink (ADR 0086: appends unconditionally, O(1), no idempotency check, no torn-tail repair)
 * - Reader traversal contract (terminated malformed line exposes typed diagnostic and continues traversal; subsequent rows reachable; 0 deduplication)
 * - S4 submission ledger channel (five kinds, subject={runId, attemptId}, cross-attempt appending)
 * - Infrastructure failure honesty (original cause propagated)
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  sitianReport,
  readSitianRecords,
  type SitianRecordInput,
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
      home,
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
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
      home,
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
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
      home,
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
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

test("Sitian facade: Log4j append-only appends unconditionally without deduplication (ADR 0086)", async () => {
  await withHermeticHome({ prefix: "ak-sitian-append-only-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const input: SitianRecordInput = {
      level: "event",
      kind: "doctor-candidate",
      cwd: project,
      home,
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
      subject: { runId: "run-idem", attemptId: "att-1" },
      identity: "canonical-idem-id-123",
      payload: { diagnosis: "healthy" },
      raw: { sessionFile: "/session.jsonl", entryId: "f-1" },
    };

    const ptr1 = sitianReport(input);
    const textAfterFirst = await readFile(ptr1.recordFile, "utf8");

    // Second write with identical canonical identity -> appends second row unconditionally
    const ptr2 = sitianReport(input);
    const textAfterSecond = await readFile(ptr1.recordFile, "utf8");

    assert.equal(ptr2.identity, ptr1.identity);
    assert.equal(ptr2.recordFile, ptr1.recordFile);
    assert.notEqual(textAfterSecond, textAfterFirst, "Unconditional append under Log4j model");

    const read = await readSitianRecords(ptr1.recordFile);
    assert.equal(read.records.length, 2, "Both records exist in canonical volume");
    assert.equal(read.records[0]!.identity, "canonical-idem-id-123");
    assert.equal(read.records[1]!.identity, "canonical-idem-id-123");
    // No sidecar claim file: the volume surface stays the single record file.
    // Not implied by the row count — a claim sidecar would sit beside it.
    const recordBase = basename(ptr1.recordFile);
    const surface = (await readdir(dirname(ptr1.recordFile)))
      .filter((name) => name === recordBase || name.startsWith(`${recordBase}.`))
      .sort();
    assert.deepEqual(surface, [recordBase]);
  });
});

test("Sitian reader: Malformed line exposes typed diagnostic and traversal continues to subsequent rows", async () => {
  await withHermeticHome({ prefix: "ak-sitian-reader-diag-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const input1: SitianRecordInput = {
      level: "event",
      kind: "auditor",
      cwd: project,
      home,
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
      subject: "reader-diag-test",
      identity: "row-1",
      payload: { audit: "pass" },
    };
    const ptr1 = sitianReport(input1);

    const corruptFragment = '{"level":"event","kind":"auditor","identity":"corrupted-frag';
    await appendFile(ptr1.recordFile, corruptFragment + "\n", "utf8");

    const input2: SitianRecordInput = {
      level: "event",
      kind: "auditor",
      cwd: project,
      home,
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
      subject: "reader-diag-test",
      identity: "row-2-canonical",
      payload: { audit: "escalate" },
    };
    sitianReport(input2);

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

test("Sitian facade: each kind owns its volume and cross-attempt writes of one kind share it", async () => {
  await withHermeticHome({ prefix: "ak-sitian-volumes-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const sessionParent = join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl");
    const write = (kind: string, attemptId: string, identity: string) => sitianReport({
      level: "event",
      kind,
      cwd: project,
      home,
      sessionParent,
      subject: { runId: "s4-run-01", attemptId },
      identity,
      payload: { identity },
    });

    const first = write("candidate", "att-1", "evt-1");
    const other = write("outcome", "att-1", "evt-2");
    const second = write("candidate", "att-2", "evt-3");

    assert.notEqual(other.recordFile, first.recordFile, "a different kind has its own volume");
    assert.equal(second.recordFile, first.recordFile, "Cross-attempt writes of one kind share the volume");
    const read = await readSitianRecords(first.recordFile);
    assert.deepEqual(read.records.map((record) => [record.kind, record.identity]), [
      ["candidate", "evt-1"],
      ["candidate", "evt-3"],
    ]);
  });
});
