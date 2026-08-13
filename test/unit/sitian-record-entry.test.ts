/**
 * #216 sitian record entry — divergent-parent nest bite.
 * Production-reachable shape: SessionManager.open(file, otherDir) ≡ pi --session-dir A --resume B.
 * Settlement reads join(dirname(sessionFile), "auditor-roles"); writer must land on the same path.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
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

  await withHermeticHome({ prefix: "ak-sitian-subject-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    const parentDir = join(machineLedgerHome(home), "books", "proj", "runs", "activation", "parent");
    await mkdir(parentDir, { recursive: true });
    const parent = SessionManager.create(project, parentDir);
    parent.appendCustomEntry("parent", { durable: true });
    const parentFile = parent.getSessionFile()!;

    const sessionDir = join(machineLedgerHome(home), "books", "proj", "navigator", "d8fabf3149c471feedba8bf9e0152384");
    await mkdir(sessionDir, { recursive: true });
    const valid = (name: string, cwd: string, id: string) => writeFile(join(sessionDir, name), [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd, parentSession: parentFile }),
      JSON.stringify({ type: "custom", id: `${id}-entry`, parentId: null, timestamp: "2025-01-01T00:00:01.000Z", customType: "principal", data: { run: 1 } }),
      "",
    ].join("\n"));
    await valid("a-new.jsonl", project, "new-valid");
    await valid("z-old.jsonl", project, "old-valid");
    await valid("y-other-cwd.jsonl", join(home, "other-project"), "other-cwd");
    await writeFile(join(sessionDir, "zz-invalid.jsonl"), "not a session header\n");
    await utimes(join(sessionDir, "z-old.jsonl"), new Date(1_000), new Date(1_000));
    await utimes(join(sessionDir, "a-new.jsonl"), new Date(2_000), new Date(2_000));
    await utimes(join(sessionDir, "y-other-cwd.jsonl"), new Date(3_000), new Date(3_000));
    await utimes(join(sessionDir, "zz-invalid.jsonl"), new Date(4_000), new Date(4_000));

    const continued = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    assert.equal(continued.getSessionFile(), join(sessionDir, "a-new.jsonl"));
    continued.appendCustomEntry("principal", { run: 2 });
    assert.equal((await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).length, 4);

    const switched = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-b", parent });
    assert.equal(switched.getSessionDir(), join(machineLedgerHome(home), "books", "proj", "navigator", "3b155d79d0059ba399a411100a61912d"));
    switched.getSessionFile();
    switched.appendCustomEntry("principal", { run: 3 });
    assert.notEqual(switched.getSessionFile(), continued.getSessionFile());

    const fresh = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-c", parent });
    fresh.appendCustomEntry("principal", { run: 4 });
    fresh.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const freshFile = fresh.getSessionFile()!;
    const header = JSON.parse((await readFile(freshFile, "utf8")).split("\n")[0]!) as { parentSession?: string };
    assert.equal(header.parentSession, parentFile);
    assert.equal((await readFile(continued.getSessionFile()!, "utf8")).match(/\"principal\"/g)?.length, 2);
  });
});
