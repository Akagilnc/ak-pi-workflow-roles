/**
 * #216/#221 archivist record entry — divergent-parent nesting + #852 navigator work-subject.
 * Production-reachable shape: SessionManager.open(file, otherDir) ≡ pi --session-dir A --resume B.
 * Settlement reads join(dirname(sessionFile), "auditor-roles"); writer must land on the same path.
 * Navigator: sole book-top exception navigator/<work-subject> across parent states.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import {
  createRecordSession,
  navigatorWorkSubjectRecordDirectory,
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

test("navigator work-subject is durable across parent states and same-subject reopen", async () => {
  await withHermeticHome({ prefix: "ak-archivist-navigator-subject-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const subject = "/work/subject-a";
    const expectedDir = navigatorWorkSubjectRecordDirectory({
      cwd: project,
      subject,
      home,
    });
    assert.equal(
      expectedDir,
      join(machineLedgerHome(home), "books", "proj", "navigator", "d8fabf3149c471feedba8bf9e0152384"),
    );

    // 无父: typed subject still lands on book-top navigator/<work-subject>.
    const noParent = createRecordSession({
      cwd: project,
      kind: "navigator",
      subject,
      home,
    });
    assert.equal(physicalPathIdentity(noParent.getSessionDir()!), physicalPathIdentity(expectedDir));
    noParent.appendCustomEntry("ak-navigator-route", { run: "no-parent" });
    assert.ok(noParent.getSessionFile(), "no-parent navigator must materialize a durable file");

    // 父未物化: parent surface present but getSessionFile empty — still durable, continues same nest.
    const unmaterialized = createRecordSession({
      cwd: project,
      kind: "navigator",
      subject,
      home,
      parent: { getSessionFile: (): string | undefined => undefined },
    });
    assert.equal(
      physicalPathIdentity(unmaterialized.getSessionDir()!),
      physicalPathIdentity(expectedDir),
    );
    assert.equal(unmaterialized.getSessionFile(), noParent.getSessionFile());
    unmaterialized.appendCustomEntry("ak-navigator-route", { run: "unmaterialized-parent" });

    // 父已物化: still book-top navigator nest; parentSession header links the parent file.
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
    // Same subject with materialized parent continues the existing durable volume.
    const materializedContinue = createRecordSession({
      cwd: project,
      kind: "navigator",
      subject,
      parent,
    });
    assert.equal(
      physicalPathIdentity(materializedContinue.getSessionDir()!),
      physicalPathIdentity(expectedDir),
    );
    assert.equal(materializedContinue.getSessionFile(), noParent.getSessionFile());
    materializedContinue.appendCustomEntry("ak-navigator-route", { run: "materialized-parent" });

    // Fresh subject + materialized parent: new nest records parentSession on the header.
    const freshSubject = "/work/subject-fresh";
    const freshDir = navigatorWorkSubjectRecordDirectory({
      cwd: project,
      subject: freshSubject,
      parentSessionFile: parentFile,
    });
    const fresh = createRecordSession({
      cwd: project,
      kind: "navigator",
      subject: freshSubject,
      parent,
    });
    assert.equal(physicalPathIdentity(fresh.getSessionDir()!), physicalPathIdentity(freshDir));
    fresh.appendCustomEntry("ak-navigator-route", { run: "fresh-with-parent" });
    fresh.appendMessage({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {},
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);
    const header = JSON.parse((await readFile(fresh.getSessionFile()!, "utf8")).split("\n")[0]!) as {
      parentSession?: string;
    };
    assert.equal(header.parentSession, parentFile);

    // Cross-run same-subject read: fresh open sees prior route entries.
    const reopened = createRecordSession({
      cwd: project,
      kind: "navigator",
      subject,
      home,
    });
    assert.equal(reopened.getSessionFile(), noParent.getSessionFile());
    const routes = reopened
      .getEntries()
      .filter((entry) => (entry as { customType?: string }).customType === "ak-navigator-route");
    assert.equal(routes.length, 3);

    // Factory public path: materialized parent → same durable pointer + entries readable.
    const factory = createNativeNavigatorSessionFactory();
    const factoryMaterialized = await factory({
      context: { cwd: project, sessionManager: parent } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(factoryMaterialized.recordPointer()!),
      physicalPathIdentity(expectedDir),
    );
    factoryMaterialized.appendEntry("ak-navigator-route", { run: "factory-materialized" });
    const factoryRoutes = factoryMaterialized
      .entries()
      .filter((entry) => (entry as { customType?: string }).customType === "ak-navigator-route");
    assert.ok(factoryRoutes.length >= 4);
    await factoryMaterialized.dispose();
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
