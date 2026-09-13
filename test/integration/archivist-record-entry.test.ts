/**
 * #216/#221 archivist record entry — divergent-parent nesting + #852 navigator work-subject.
 * Navigator durable behavior: one real factory tracer (external pointer/entries only).
 */
import assert from "node:assert/strict";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { createRecordSession } from "../../src/archivist-record-entry.ts";
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

function assertBookTopNavigatorPointer(pointer: string, home: string): void {
  const resolved = physicalPathIdentity(pointer);
  assert.ok(
    resolved.startsWith(`${physicalPathIdentity(machineLedgerHome(home))}${sep}`),
    "pointer must stay under hermetic ledger home",
  );
  assert.ok(
    resolved.includes(`${sep}navigator${sep}`),
    "pointer must sit under book-top navigator/",
  );
}

/**
 * Sole navigator durable tracer via the public factory:
 * three parent states share one nest, cross-reopen keeps entries, and a real
 * dual-session sidecarless volume adopts by cwd + mtime recency.
 */
test("navigator factory durable nest: parent states, reopen, dual-session adopt", async () => {
  await withHermeticHome({ prefix: "ak-archivist-navigator-subject-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const subject = "/work/subject-a";
    const factory = createNativeNavigatorSessionFactory();

    const noParent = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject,
      tool: undefined as never,
    });
    const nest = noParent.recordPointer()!;
    assertBookTopNavigatorPointer(nest, home);
    noParent.appendEntry("ak-navigator-route", { run: "no-parent" });

    const unmaterialized = await factory({
      context: {
        cwd: project,
        home,
        sessionManager: { getSessionFile: () => undefined },
      } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(physicalPathIdentity(unmaterialized.recordPointer()!), physicalPathIdentity(nest));
    unmaterialized.appendEntry("ak-navigator-route", { run: "unmaterialized-parent" });

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
    assert.equal(physicalPathIdentity(materialized.recordPointer()!), physicalPathIdentity(nest));
    materialized.appendEntry("ak-navigator-route", { run: "materialized-parent" });

    const reopened = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject,
      tool: undefined as never,
    });
    assert.equal(physicalPathIdentity(reopened.recordPointer()!), physicalPathIdentity(nest));
    assert.deepEqual(routeRuns(reopened.entries()), [
      "no-parent",
      "unmaterialized-parent",
      "materialized-parent",
    ]);

    await noParent.dispose();
    await unmaterialized.dispose();
    await materialized.dispose();
    await reopened.dispose();

    // Real dual-session sidecarless shape (production has one such volume):
    // same header.cwd, distinct mtimes — adopt the newer without treating multi-file as ambiguity.
    const dualSubject = "/work/subject-dual-legacy";
    const seed = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject: dualSubject,
      tool: undefined as never,
    });
    const dualNest = seed.recordPointer()!;
    assertBookTopNavigatorPointer(dualNest, home);
    await seed.dispose();
    for (const name of await readdir(dualNest)) {
      await rm(join(dualNest, name), { force: true });
    }
    const olderFile = join(dualNest, "2026-09-01T18-42-28-846Z_01a05e47-a56e-7633-8ce5-7cce276b09c5.jsonl");
    const newerFile = join(dualNest, "2026-09-02T02-33-34-005Z_01a05ff6-f035-7a88-978d-9010e0c54a6d.jsonl");
    const sessionLine = (id: string, stamp: string) =>
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: stamp,
        cwd: project,
      })}\n`;
    const routeLine = (run: string, id: string, stamp: string) =>
      `${JSON.stringify({
        type: "custom",
        customType: "ak-navigator-route",
        data: { run },
        id,
        parentId: null,
        timestamp: stamp,
      })}\n`;
    await writeFile(
      olderFile,
      `${sessionLine("01a05e47-a56e-7633-8ce5-7cce276b09c5", "2026-09-01T18:42:28.846Z")}${routeLine("from-older", "r-old", "2026-09-01T18:42:29.000Z")}`,
    );
    await writeFile(
      newerFile,
      `${sessionLine("01a05ff6-f035-7a88-978d-9010e0c54a6d", "2026-09-02T02:33:34.005Z")}${routeLine("from-newer", "r-new", "2026-09-02T02:33:35.000Z")}`,
    );
    const olderTime = new Date("2026-09-02T02:32:00.000Z");
    const newerTime = new Date("2026-09-03T02:40:26.000Z");
    await utimes(olderFile, olderTime, olderTime);
    await utimes(newerFile, newerTime, newerTime);

    const adopted = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject: dualSubject,
      tool: undefined as never,
    });
    assert.equal(physicalPathIdentity(adopted.recordPointer()!), physicalPathIdentity(dualNest));
    assert.deepEqual(routeRuns(adopted.entries()), ["from-newer"]);
    adopted.appendEntry("ak-navigator-route", { run: "after-adopt" });
    const adoptedAgain = await factory({
      context: { cwd: project, home, sessionManager: undefined } as never,
      subject: dualSubject,
      tool: undefined as never,
    });
    assert.deepEqual(routeRuns(adoptedAgain.entries()), ["from-newer", "after-adopt"]);
    await adopted.dispose();
    await adoptedAgain.dispose();
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
