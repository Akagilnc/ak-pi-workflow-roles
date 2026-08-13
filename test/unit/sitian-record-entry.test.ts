/**
 * #216 sitian record entry — divergent-parent nest bite.
 * Production-reachable shape: SessionManager.open(file, otherDir) ≡ pi --session-dir A --resume B.
 * Settlement reads join(dirname(sessionFile), "auditor-roles"); writer must land on the same path.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { physicalPathIdentity } from "../../src/activation-ledger-topology.ts";
import { createRecordSession } from "../../src/sitian-record-entry.ts";
import {
  machineLedgerHome,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("createRecordSession nests by parent file when SessionManager file and dir diverge", async () => {
  await withHermeticHome({ prefix: "ak-sitian-divergent-" }, async ({ home }) => {
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
});

test("createRecordSession owns subject placement, continuation, switching, and parent correlation", async () => {
  await withHermeticHome({ prefix: "ak-sitian-subject-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    const parentDir = join(machineLedgerHome(home), "books", "proj", "runs", "activation", "parent");
    await mkdir(parentDir, { recursive: true });
    const parent = SessionManager.create(project, parentDir);
    parent.appendCustomEntry("parent", { durable: true });
    const parentFile = parent.getSessionFile()!;

    const first = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    assert.equal(first.getSessionDir(), join(machineLedgerHome(home), "books", "proj", "navigator", "d8fabf3149c471feedba8bf9e0152384"));
    const firstFile = first.getSessionFile()!;
    await writeFile(firstFile, [
      JSON.stringify({ type: "session", version: 3, id: "navigator-a", timestamp: "2025-01-01T00:00:00.000Z", cwd: project, parentSession: parentFile }),
      JSON.stringify({ type: "custom", id: "one", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", customType: "principal", data: { run: 1 } }),
      "",
    ].join("\n"));
    const firstFiles = (await readdir(first.getSessionDir())).filter((name) => name.endsWith(".jsonl"));
    assert.equal(firstFiles.length, 1);
    const continued = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    assert.equal(continued.getSessionFile(), firstFile);
    continued.appendCustomEntry("principal", { run: 2 });
    assert.deepEqual((await readdir(first.getSessionDir())).filter((name) => name.endsWith(".jsonl")), firstFiles);

    const switched = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-b", parent });
    assert.equal(switched.getSessionDir(), join(machineLedgerHome(home), "books", "proj", "navigator", "3b155d79d0059ba399a411100a61912d"));
    switched.getSessionFile();
    switched.appendCustomEntry("principal", { run: 3 });
    assert.notEqual(switched.getSessionFile(), firstFile);

    const bytes = await readFile(firstFile, "utf8");
    const header = JSON.parse(bytes.split("\n")[0]!) as { parentSession?: string };
    assert.equal(header.parentSession, parentFile);
    assert.equal(bytes.match(/\"principal\"/g)?.length, 2);
  });
});
