/**
 * #216/#221 archivist record entry — divergent-parent nest + subject-keyed navigator tracer.
 * Production-reachable shape: SessionManager.open(file, otherDir) ≡ pi --session-dir A --resume B.
 * Settlement reads join(dirname(sessionFile), "auditor-roles"); writer must land on the same path.
 * Subject tracer: subject→dir, same-subject continue, switch isolation, parentSession header.
 * #221/#525 nest-circle: same-book cross-nest pointer and books/A→B final .jsonl symlink refused before open.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ActivationLedgerError,
  physicalPathIdentity,
} from "../../src/activation-ledger-topology.ts";
import { createRecordSession } from "../../src/archivist-record-entry.ts";
import {
  machineLedgerHome,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("createRecordSession nests by parent file and continues subject-keyed navigator records", async () => {
  await withHermeticHome({ prefix: "ak-archivist-divergent-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const parentDir = join(machineLedgerHome(home), "books", "proj", "runs", "activation", "parent-run");
    // Divergent sessionDir under the same ledger home (pi --session-dir A --resume B).
    const otherDir = join(machineLedgerHome(home), "books", "proj", "runs", "activation", "other-session-dir");
    await mkdir(parentDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });

    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "divergent-parent",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project,
      })}\n`,
    );

    const parent = SessionManager.open(parentFile, otherDir);
    assert.equal(parent.getSessionFile(), parentFile);
    assert.notEqual(dirname(parent.getSessionFile()!), parent.getSessionDir());

    const child = createRecordSession({
      cwd: project,
      kind: "auditor-roles",
      parent,
    });

    const expected = join(dirname(parentFile), "auditor-roles");
    assert.equal(child.getSessionDir(), expected);
    // Settlement readBoundAuditorKnownFailure joins dirname(sessionFile)/auditor-roles.
    const settlementRead = join(dirname(parent.getSessionFile()!), "auditor-roles");
    assert.equal(physicalPathIdentity(child.getSessionDir()), physicalPathIdentity(settlementRead));
  });

  await withHermeticHome({ prefix: "ak-archivist-subject-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    const parentDir = join(machineLedgerHome(home), "books", "proj", "runs", "activation", "parent");
    await mkdir(parentDir, { recursive: true });
    const parent = SessionManager.create(project, parentDir);
    parent.appendCustomEntry("parent", { durable: true });
    const parentFile = parent.getSessionFile()!;
    const bookNavigator = join(machineLedgerHome(home), "books", "proj", "navigator");

    // subject → directory (message flush materializes the deferred session file)
    const first = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    const dirA = join(bookNavigator, "d8fabf3149c471feedba8bf9e0152384");
    assert.equal(first.getSessionDir(), dirA);
    first.appendCustomEntry("principal", { run: 1 });
    first.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const firstFile = first.getSessionFile()!;

    // same subject continues the same session through the AK-owned pointer ledger
    const continued = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    assert.equal(continued.getSessionFile(), firstFile);
    continued.appendCustomEntry("principal", { run: 2 });

    // Missing current-session after nest exists is a first-publisher window (not corrupt):
    // claim a fresh principal rather than fail the open (concurrent first-create recovery).
    await rm(join(dirA, "current-session.json"));
    const reclaimed = createRecordSession({
      cwd: project,
      kind: "navigator",
      subject: "/work/subject-a",
      parent,
    });
    const reclaimedFile = reclaimed.getSessionFile()!;
    assert.notEqual(
      reclaimedFile,
      firstFile,
      "missing claim mints a fresh principal under the same nest",
    );
    assert.equal(
      JSON.parse(await readFile(join(dirA, "current-session.json"), "utf8")).sessionFile,
      reclaimedFile,
    );
    await writeFile(join(dirA, "current-session.json"), "not-json");
    assert.throws(
      () => createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent }),
      (error: unknown) => error instanceof ActivationLedgerError && error.code === "AK_ACTIVATION_LEDGER",
    );
    await writeFile(join(dirA, "current-session.json"), `${JSON.stringify({ sessionFile: firstFile })}\n`);

    // Same-book cross-nest pointer: subject-a nest points at subject-b's legal file → refuse before open.
    const peerB = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-b", parent });
    peerB.appendCustomEntry("principal", { run: "peer-b" });
    peerB.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const peerBFile = peerB.getSessionFile()!;
    await writeFile(join(dirA, "current-session.json"), `${JSON.stringify({ sessionFile: peerBFile })}\n`);
    assert.throws(
      () => createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent }),
      (error: unknown) => error instanceof ActivationLedgerError && error.code === "AK_ACTIVATION_LEDGER",
    );
    await writeFile(join(dirA, "current-session.json"), `${JSON.stringify({ sessionFile: firstFile })}\n`);

    // Cross-book final-file symlink: books/A nest points at a legal books/B session → refuse before open.
    const foreignDir = join(machineLedgerHome(home), "books", "foreign", "navigator", "peer");
    await mkdir(foreignDir, { recursive: true });
    const foreignFile = join(foreignDir, "foreign-session.jsonl");
    await writeFile(
      foreignFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "foreign-peer",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project,
      })}\n`,
    );
    const linkName = join(dirA, basename(firstFile));
    await rm(firstFile);
    await symlink(foreignFile, linkName);
    assert.throws(
      () => createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent }),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    // Restore a regular principal so later subject-a reads stay honest about in-book bytes.
    await rm(linkName);
    await writeFile(
      firstFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "restored-subject-a",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project,
      })}\n{"type":"custom","customType":"principal","data":{"run":1}}\n{"type":"custom","customType":"principal","data":{"run":2}}\n`,
    );

    // switched subject isolates to a different directory/session
    const switched = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-b", parent });
    assert.equal(switched.getSessionDir(), join(bookNavigator, "3b155d79d0059ba399a411100a61912d"));
    switched.appendCustomEntry("principal", { run: 3 });
    switched.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    assert.notEqual(switched.getSessionFile(), firstFile);

    // parentSession correlation on a fresh subject record
    const fresh = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-c", parent });
    fresh.appendCustomEntry("principal", { run: 4 });
    fresh.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const freshFile = fresh.getSessionFile()!;
    const header = JSON.parse((await readFile(freshFile, "utf8")).split("\n")[0]!) as { parentSession?: string };
    assert.equal(header.parentSession, parentFile);
    assert.equal((await readFile(firstFile, "utf8")).match(/\"principal\"/g)?.length, 2);
  });
});

test("Sitian facade: three levels, with/without usage, and raw pointer can open canonical volume", async () => {
  await withHermeticHome({ prefix: "ak-sitian-three-levels-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const { sitianReport, readSitianRecords } = await import("../../src/sitian-facade.ts");

    // Case 1: run-summary with usage
    // #604: explicit home — packageMachineHome ignores process.env.HOME.
    const summaryPtr = sitianReport({
      level: "run-summary",
      kind: "settlement-summary",
      cwd: project,
      home,
      subject: { runId: "r-sum-1", attemptId: "att-1" },
      payload: { status: "completed" },
      usage: { promptTokens: 42, completionTokens: 18, totalTokens: 60 },
    });
    assert.equal(summaryPtr.level, "run-summary");
    const summaryRead = await readSitianRecords(summaryPtr.recordFile);
    assert.equal(summaryRead.records.length, 1);
    assert.equal(summaryRead.records[0]!.usage?.totalTokens, 60);

    // Case 2: event without usage, with raw reference
    const rawFile = join(home, "raw-session.jsonl");
    await writeFile(rawFile, '{"type":"session"}\n', "utf8");
    const eventPtr = sitianReport({
      level: "event",
      kind: "gate",
      cwd: project,
      home,
      subject: { runId: "r-evt-1" },
      payload: { reminder: true },
      raw: { sessionFile: rawFile, entryId: "entry-99" },
    });
    assert.equal(eventPtr.level, "event");
    const eventRead = await readSitianRecords(eventPtr.recordFile);
    assert.equal(eventRead.records.length, 1);
    assert.equal(eventRead.records[0]!.usage, undefined);
    assert.equal(eventRead.records[0]!.raw?.sessionFile, rawFile);
    assert.equal(eventRead.records[0]!.raw?.entryId, "entry-99");

    // Case 3: protocol-snapshot without usage, without raw reference
    const snapPtr = sitianReport({
      level: "protocol-snapshot",
      kind: "auditor-roles",
      cwd: project,
      home,
      subject: "snap-sub-1",
      payload: { state: "initialized" },
    });
    assert.equal(snapPtr.level, "protocol-snapshot");
    const snapRead = await readSitianRecords(snapPtr.recordFile);
    assert.equal(snapRead.records.length, 1);
    assert.equal(snapRead.records[0]!.level, "protocol-snapshot");
    assert.equal(snapRead.records[0]!.raw, undefined);
    assert.equal(snapRead.records[0]!.usage, undefined);
  });
});
