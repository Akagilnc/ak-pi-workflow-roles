/**
 * #216/#221 archivist record entry — divergent-parent nesting + #852 navigator work-subject.
 * Navigator: one independent factory tracer (external topology + entries only).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  ActivationLedgerError,
  physicalPathIdentity,
} from "../../src/activation-ledger-topology.ts";
import {
  createRecordSession,
  createRecordSessionOpen,
  WORKER_SUBMISSION_GATE_KIND,
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
    assert.equal(
      physicalPathIdentity(child.getSessionDir()),
      physicalPathIdentity(join(dirname(parent.getSessionFile()!), "auditor-roles")),
    );
  });
});

test("worker gate native continuation reports and materializes an empty-nest fallback as fresh", async () => {
  await withHermeticHome({ prefix: "ak-archivist-gate-fresh-" }, async ({ home }) => {
    const project = join(home, "proj");
    const parentDir = join(machineLedgerHome(home), "books", "proj", "1003", "runs", "r@coder", "session");
    await mkdir(parentDir, { recursive: true });
    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(parentFile, sessionJsonl("parent", project, "parent"));
    const parent = SessionManager.open(parentFile, parentDir, project);
    const gateDir = join(parentDir, WORKER_SUBMISSION_GATE_KIND);
    await mkdir(gateDir, { recursive: true });

    const opened = createRecordSessionOpen({
      cwd: project,
      kind: WORKER_SUBMISSION_GATE_KIND,
      parent,
    });

    assert.equal(opened.resumed, false);
    const file = opened.session.getSessionFile();
    assert.ok(file);
    const header = JSON.parse((await readFile(file, "utf8")).split("\n")[0]!) as {
      parentSession?: string;
    };
    assert.equal(header.parentSession, parentFile);
  });
});

test("worker gate native continuation refuses a session symlink outside its authorized nest", async () => {
  await withHermeticHome({ prefix: "ak-archivist-gate-escape-" }, async ({ home }) => {
    const project = join(home, "proj");
    const parentDir = join(machineLedgerHome(home), "books", "proj", "1003", "runs", "r@coder", "session");
    await mkdir(parentDir, { recursive: true });
    const parentFile = join(parentDir, "session.jsonl");
    await writeFile(parentFile, sessionJsonl("parent", project, "parent"));
    const parent = SessionManager.open(parentFile, parentDir, project);
    const gateDir = join(parentDir, WORKER_SUBMISSION_GATE_KIND);
    await mkdir(gateDir, { recursive: true });
    const outside = join(home, "outside.jsonl");
    const outsideBefore = `${JSON.stringify({
      type: "session",
      version: 1,
      id: "outside",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: project,
    })}\n`;
    await writeFile(outside, outsideBefore);
    await symlink(outside, join(gateDir, "recent.jsonl"));

    assert.throws(
      () => createRecordSessionOpen({ cwd: project, kind: WORKER_SUBMISSION_GATE_KIND, parent }),
      (error: unknown) =>
        error instanceof ActivationLedgerError
        && error.message.includes("must be under the authorized nest"),
    );
    assert.equal(await readFile(outside, "utf8"), outsideBefore);
  });
});

/** Independent book-top nest contract — join/hash only, never the placement helper under test. */
function expectedNavigatorNest(home: string, bookKey: string, subject: string): string {
  const digest = createHash("sha256").update(subject).digest("hex").slice(0, 32);
  return join(machineLedgerHome(home), "books", bookKey, "navigator", digest);
}

function routeRuns(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry) => (entry as { customType?: string }).customType === "ak-navigator-route")
    .map((entry) => (entry as { data?: { run?: unknown } }).data?.run)
    .filter((run): run is string => typeof run === "string");
}

function sessionJsonl(id: string, cwd: string, route: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-01T00:00:00.000Z",
    cwd,
  })}\n${JSON.stringify({
    type: "custom",
    customType: "ak-navigator-route",
    data: { run: route },
    id: `${id}-route`,
    parentId: null,
    timestamp: "2026-09-01T00:00:01.000Z",
  })}\n`;
}

/**
 * Sole navigator factory tracer: table-driven parent states, independent nest path,
 * Unicode cwd adopt, wrong-cwd recency, no-match mint, one I/O failure.
 */
test("navigator factory durable nest: parent states, unicode cwd, wrong-cwd, no-match, io fail", async () => {
  await withHermeticHome({ prefix: "ak-archivist-navigator-subject-" }, async ({ home }) => {
    // Book key and calling cwd carry ordinary legal Unicode — external adopt contract,
    // not a chunk-boundary probe.
    const project = join(home, "proj-导航-α");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    const bookKey = "proj-导航-α";

    const subject = "/work/subject-a";
    const nest = expectedNavigatorNest(home, bookKey, subject);
    const factory = createNativeNavigatorSessionFactory();
    // HostContext.runDirectory is the admitted-run ledger identity (#852 / #879) — not context.home.
    const runDirectory = join(
      machineLedgerHome(home),
      "books",
      bookKey,
      "unbound",
      "runs",
      "nav-run@navigator",
    );
    await mkdir(join(runDirectory, "session"), { recursive: true });

    const parentDir = join(
      machineLedgerHome(home),
      "books",
      bookKey,
      "871",
      "runs",
      "r1@judge",
      "session",
    );
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

    const parentStates = [
      { label: "no-parent", sessionManager: undefined as unknown },
      { label: "unmaterialized-parent", sessionManager: { getSessionFile: () => undefined } },
      { label: "materialized-parent", sessionManager: parent },
    ] as const;

    let last: Awaited<ReturnType<ReturnType<typeof createNativeNavigatorSessionFactory>>> | undefined;
    for (const state of parentStates) {
      const session = await factory({
        context: { cwd: project, runDirectory, sessionManager: state.sessionManager } as never,
        subject,
        tool: undefined as never,
      });
      // Nest and admitted run share one ledger home — never a second passwd/env home.
      assert.equal(physicalPathIdentity(session.recordPointer()!), physicalPathIdentity(nest));
      session.appendEntry("ak-navigator-route", { run: state.label });
      last = session;
    }
    assert.deepEqual(routeRuns(last!.entries()), [
      "no-parent",
      "unmaterialized-parent",
      "materialized-parent",
    ]);
    await last!.dispose();

    // Foreign parent path (not under .ak-roles) must not displace runDirectory home.
    const foreignParentFile = join(home, "outside-ledger", "session.jsonl");
    await mkdir(dirname(foreignParentFile), { recursive: true });
    await writeFile(
      foreignParentFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "foreign-parent",
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: project,
      })}\n`,
    );
    const foreignSubject = "/work/subject-foreign-parent";
    const foreignNest = expectedNavigatorNest(home, bookKey, foreignSubject);
    const foreignSession = await factory({
      context: {
        cwd: project,
        runDirectory,
        sessionManager: { getSessionFile: () => foreignParentFile },
      } as never,
      subject: foreignSubject,
      tool: undefined as never,
    });
    assert.equal(
      physicalPathIdentity(foreignSession.recordPointer()!),
      physicalPathIdentity(foreignNest),
    );
    await foreignSession.dispose();

    // Legacy: newer wrong-cwd must not win; older matching Unicode cwd (leading blanks) adopts.
    const legacySubject = "/work/subject-legacy-cwd";
    const legacyNest = expectedNavigatorNest(home, bookKey, legacySubject);
    await mkdir(legacyNest, { recursive: true });
    const olderMatching = join(legacyNest, "older-matching.jsonl");
    const newerWrongCwd = join(legacyNest, "newer-wrong-cwd.jsonl");
    await writeFile(
      olderMatching,
      `\n\n${sessionJsonl("older-id", project, "matching-older")}`,
    );
    await writeFile(
      newerWrongCwd,
      sessionJsonl("newer-id", join(project, "other"), "wrong-cwd-newer"),
    );
    const olderTime = new Date("2026-09-02T00:00:00.000Z");
    const newerTime = new Date("2026-09-03T00:00:00.000Z");
    await utimes(olderMatching, olderTime, olderTime);
    await utimes(newerWrongCwd, newerTime, newerTime);

    const adopted = await factory({
      context: { cwd: project, runDirectory, sessionManager: undefined } as never,
      subject: legacySubject,
      tool: undefined as never,
    });
    assert.equal(physicalPathIdentity(adopted.recordPointer()!), physicalPathIdentity(legacyNest));
    assert.deepEqual(routeRuns(adopted.entries()), ["matching-older"]);
    await adopted.dispose();

    // No cwd match → mint fresh (old null path).
    const noMatchSubject = "/work/subject-no-match";
    const noMatchNest = expectedNavigatorNest(home, bookKey, noMatchSubject);
    await mkdir(noMatchNest, { recursive: true });
    await writeFile(
      join(noMatchNest, "foreign.jsonl"),
      sessionJsonl("foreign-id", join(project, "foreign"), "foreign-only"),
    );
    const minted = await factory({
      context: { cwd: project, runDirectory, sessionManager: undefined } as never,
      subject: noMatchSubject,
      tool: undefined as never,
    });
    assert.equal(physicalPathIdentity(minted.recordPointer()!), physicalPathIdentity(noMatchNest));
    assert.deepEqual(routeRuns(minted.entries()), []);
    minted.appendEntry("ak-navigator-route", { run: "fresh-mint" });
    assert.deepEqual(routeRuns(minted.entries()), ["fresh-mint"]);
    const leaves = (await readdir(noMatchNest)).filter((name) => name.endsWith(".jsonl"));
    assert.ok(leaves.length >= 2);
    await minted.dispose();

    // First non-blank non-header line is terminal rejection — later valid header must not adopt.
    const rejectSubject = "/work/subject-header-reject";
    const rejectNest = expectedNavigatorNest(home, bookKey, rejectSubject);
    await mkdir(rejectNest, { recursive: true });
    await writeFile(
      join(rejectNest, "noise-then-header.jsonl"),
      `${JSON.stringify({ type: "message", role: "user" })}\n${sessionJsonl("later-header", project, "should-not-adopt")}`,
    );
    const rejected = await factory({
      context: { cwd: project, runDirectory, sessionManager: undefined } as never,
      subject: rejectSubject,
      tool: undefined as never,
    });
    assert.equal(physicalPathIdentity(rejected.recordPointer()!), physicalPathIdentity(rejectNest));
    assert.deepEqual(routeRuns(rejected.entries()), []);
    rejected.appendEntry("ak-navigator-route", { run: "fresh-after-reject" });
    assert.deepEqual(routeRuns(rejected.entries()), ["fresh-after-reject"]);
    await rejected.dispose();

    // One deterministic file-level I/O failure → external ActivationLedgerError (not washed).
    // Self-loop .jsonl symlink (same shape as existing public-cli PATH loop fixtures):
    // stable across root/DAC models — not chmod(0).
    const ioSubject = "/work/subject-io-fail";
    const ioNest = expectedNavigatorNest(home, bookKey, ioSubject);
    await mkdir(ioNest, { recursive: true });
    const blocked = join(ioNest, "blocked.jsonl");
    await symlink(blocked, blocked);
    await assert.rejects(
      () =>
        factory({
          context: { cwd: project, runDirectory, sessionManager: undefined } as never,
          subject: ioSubject,
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
