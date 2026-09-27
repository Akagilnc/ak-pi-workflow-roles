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

test("worker gate delegates native continuation without package path checks", async () => {
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
    await writeFile(outside, sessionJsonl("outside", project, "outside"));
    const continued = SessionManager.open(outside, gateDir, project);
    const host = {
      openRecordSession: ({ sessionFile, sessionDir, cwd }: {
        sessionFile: string;
        sessionDir: string;
        cwd: string;
      }) => SessionManager.open(sessionFile, sessionDir, cwd),
      createRecordSession: ({ cwd, sessionDir, parentSession }: {
        cwd: string;
        sessionDir: string;
        parentSession?: string;
      }) => SessionManager.create(cwd, sessionDir, parentSession === undefined ? undefined : { parentSession }),
      continueRecentRecordSession: () => ({ session: continued, resumed: true }),
      inMemoryRecordSession: (cwd: string) => SessionManager.inMemory(cwd),
    };

    const opened = createRecordSessionOpen({
      cwd: project,
      kind: WORKER_SUBMISSION_GATE_KIND,
      parent,
    }, host);
    assert.equal(opened.resumed, true);
    assert.equal(opened.session.getSessionFile(), outside);
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
