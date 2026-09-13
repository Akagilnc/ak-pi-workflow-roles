/**
 * #216/#221 archivist record entry — divergent-parent nesting + #852 navigator work-subject.
 * Production-reachable shape: SessionManager.open(file, otherDir) ≡ pi --session-dir A --resume B.
 * Settlement reads join(dirname(sessionFile), "auditor-roles"); writer must land on the same path.
 * Navigator durable behavior: one real factory tracer (no parallel createRecordSession matrix).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ActivationLedgerError,
  physicalPathIdentity,
} from "../../src/activation-ledger-topology.ts";
import {
  createRecordSession,
  resolveNavigatorWorkSubjectPlacement,
} from "../../src/archivist-record-entry.ts";
import { createNativeNavigatorSessionFactory } from "../../src/navigator-public-session.ts";
import {
  machineLedgerHome,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("createRecordSession nests by the durable parent file", async () => {
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
    // Settlement read boundAuditorKnownFailure joins dirname(sessionFile)/auditor-roles.
    const settlementRead = join(dirname(parent.getSessionFile()!), "auditor-roles");
    assert.equal(physicalPathIdentity(child.getSessionDir()), physicalPathIdentity(settlementRead));
  });
});

function routeRuns(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry) => (entry as { customType?: string }).customType === "ak-navigator-route")
    .map((entry) => (entry as { data?: { run?: unknown } }).data?.run)
    .filter((run): run is string => typeof run === "string");
}

/**
 * Sole navigator durable tracer: real factory entry covers no-parent / unmaterialized /
 * materialized parent, cross-reopen entries, and a real sidecarless legacy nest.
 * Bare multi-session ambiguity is the only createRecordSession-only negative (factory
 * cannot seed two principals without going through the writer that installs sidecar).
 */
test("navigator factory durable nest: parent states, reopen, sidecarless adopt", async () => {
  await withHermeticHome({ prefix: "ak-archivist-navigator-subject-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const subject = "/work/subject-a";
    const placement = resolveNavigatorWorkSubjectPlacement({
      cwd: project,
      subject,
      home,
    });
    const bookNavigator = join(machineLedgerHome(home), "books", "proj", "navigator");
    assert.equal(
      physicalPathIdentity(dirname(placement.sessionDir)),
      physicalPathIdentity(bookNavigator),
    );
    assert.equal(
      physicalPathIdentity(placement.ledgerHome),
      physicalPathIdentity(machineLedgerHome(home)),
    );

    const factory = createNativeNavigatorSessionFactory();

    // 无父
    const noParent = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(noParent.recordPointer()!),
      physicalPathIdentity(placement.sessionDir),
    );
    noParent.appendEntry("ak-navigator-route", { run: "no-parent" });
    assert.deepEqual(routeRuns(noParent.entries()), ["no-parent"]);

    // 父未物化
    const unmaterialized = await factory({
      context: {
        cwd: project,
        home,
        sessionManager: { getSessionFile: () => undefined },
      } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(unmaterialized.recordPointer()!),
      physicalPathIdentity(placement.sessionDir),
    );
    assert.deepEqual(routeRuns(unmaterialized.entries()), ["no-parent"]);
    unmaterialized.appendEntry("ak-navigator-route", { run: "unmaterialized-parent" });

    // 父已物化
    const parentDir = join(machineLedgerHome(home), "books", "proj", "871", "runs", "r1@judge", "session");
    await mkdir(parentDir, { recursive: true });
    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(
      parentFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "materialized-parent",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project,
      })}\n`,
    );
    const parent = SessionManager.open(parentFile, parentDir);
    const materialized = await factory({
      context: { cwd: project, home, sessionManager: parent } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(materialized.recordPointer()!),
      physicalPathIdentity(placement.sessionDir),
    );
    assert.deepEqual(routeRuns(materialized.entries()), [
      "no-parent",
      "unmaterialized-parent",
    ]);
    materialized.appendEntry("ak-navigator-route", { run: "materialized-parent" });
    assert.deepEqual(routeRuns(materialized.entries()), [
      "no-parent",
      "unmaterialized-parent",
      "materialized-parent",
    ]);

    // Cross-run reopen via factory (no parent) — same durable pointer + entries.
    const reopened = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(reopened.recordPointer()!),
      physicalPathIdentity(placement.sessionDir),
    );
    assert.deepEqual(routeRuns(reopened.entries()), [
      "no-parent",
      "unmaterialized-parent",
      "materialized-parent",
    ]);

    await noParent.dispose();
    await unmaterialized.dispose();
    await materialized.dispose();
    await reopened.dispose();

    // Real sidecarless legacy volume: one valid session.jsonl, no current-session.json.
    // Mimics T11 copyTree / pre-sidecar disk — not a new-writer fixture that already has sidecar.
    const legacySubject = "/work/subject-legacy-sidecarless";
    const legacyPlacement = resolveNavigatorWorkSubjectPlacement({
      cwd: project,
      subject: legacySubject,
      home,
    });
    await mkdir(legacyPlacement.sessionDir, { recursive: true });
    const legacySessionFile = join(
      legacyPlacement.sessionDir,
      "2026-08-12T16-04-48-010Z_019ff6b8-190a-7bbc-8657-f412c0dda03c.jsonl",
    );
    await writeFile(
      legacySessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "legacy-sidecarless",
        timestamp: "2026-08-12T16:04:48.010Z",
        cwd: project,
      })}\n${JSON.stringify({
        type: "custom",
        customType: "ak-navigator-route",
        data: { run: "legacy-on-disk" },
        id: "legacy-route-1",
        parentId: null,
        timestamp: "2026-08-12T16:04:49.000Z",
      })}\n`,
    );
    // Ensure no sidecar present.
    await rm(join(legacyPlacement.sessionDir, "current-session.json"), { force: true });

    const legacyAdopted = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject: legacySubject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(legacyAdopted.recordPointer()!),
      physicalPathIdentity(legacyPlacement.sessionDir),
    );
    assert.deepEqual(routeRuns(legacyAdopted.entries()), ["legacy-on-disk"]);
    legacyAdopted.appendEntry("ak-navigator-route", { run: "after-adopt" });
    // Sidecar established once — second open continues without re-adoption path.
    const sidecar = JSON.parse(
      await readFile(join(legacyPlacement.sessionDir, "current-session.json"), "utf8"),
    ) as { sessionFile?: string };
    assert.equal(
      physicalPathIdentity(sidecar.sessionFile!),
      physicalPathIdentity(legacySessionFile),
    );
    const legacyReopen = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject: legacySubject,
      tool: undefined as never,
    });
    assert.deepEqual(routeRuns(legacyReopen.entries()), ["legacy-on-disk", "after-adopt"]);
    await legacyAdopted.dispose();
    await legacyReopen.dispose();

    // Multi-session sidecarless nest is real ambiguity — loud fail (bare seam).
    const multiSubject = "/work/subject-multi-ambiguous";
    const multiPlacement = resolveNavigatorWorkSubjectPlacement({
      cwd: project,
      subject: multiSubject,
      home,
    });
    await mkdir(multiPlacement.sessionDir, { recursive: true });
    for (const leaf of ["a.jsonl", "b.jsonl"] as const) {
      await writeFile(
        join(multiPlacement.sessionDir, leaf),
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: `multi-${leaf}`,
          timestamp: "2026-08-12T16:04:48.010Z",
          cwd: project,
        })}\n`,
      );
    }
    await rm(join(multiPlacement.sessionDir, "current-session.json"), { force: true });
    await assert.rejects(
      () =>
        factory({
          context: { cwd: project, home, sessionManager: undefined } as never,
          subject: multiSubject,
          tool: undefined as never,
        }),
      (error: unknown) =>
        error instanceof ActivationLedgerError && error.code === "AK_ACTIVATION_LEDGER",
    );

    // Zero-candidate sidecarless nest — loud fail.
    const emptySubject = "/work/subject-empty-nest";
    const emptyPlacement = resolveNavigatorWorkSubjectPlacement({
      cwd: project,
      subject: emptySubject,
      home,
    });
    await mkdir(emptyPlacement.sessionDir, { recursive: true });
    await rm(join(emptyPlacement.sessionDir, "current-session.json"), { force: true });
    await assert.rejects(
      () =>
        factory({
          context: { cwd: project, home, sessionManager: undefined } as never,
          subject: emptySubject,
          tool: undefined as never,
        }),
      (error: unknown) =>
        error instanceof ActivationLedgerError && error.code === "AK_ACTIVATION_LEDGER",
    );
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
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
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
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
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
      sessionParent: join(home, ".ak-roles", "books", "proj", "runs", "parent", "session.jsonl"),
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
