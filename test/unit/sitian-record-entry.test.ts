/**
 * #216/#221 sitian record entry — divergent-parent nest + subject-keyed navigator tracer.
 * Production-reachable shape: SessionManager.open(file, otherDir) ≡ pi --session-dir A --resume B.
 * Settlement reads join(dirname(sessionFile), "auditor-roles"); writer must land on the same path.
 * Subject tracer: subject→dir, same-subject continue, switch isolation, parentSession header.
 * #221 book-circle: books/A final .jsonl symlink → books/B legal session is refused before open.
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
import { createRecordSession } from "../../src/sitian-record-entry.ts";
import {
  machineLedgerHome,
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";

test("createRecordSession nests by parent file and continues subject-keyed navigator records", async () => {
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
    const bookNavigator = join(machineLedgerHome(home), "books", "proj", "navigator");

    // subject → directory (message flush materializes the deferred session file)
    const first = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    const dirA = join(bookNavigator, "d8fabf3149c471feedba8bf9e0152384");
    assert.equal(first.getSessionDir(), dirA);
    first.appendCustomEntry("principal", { run: 1 });
    first.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const firstFile = first.getSessionFile()!;

    // same subject continues the same session
    const continued = createRecordSession({ cwd: project, kind: "navigator", subject: "/work/subject-a", parent });
    assert.equal(continued.getSessionFile(), firstFile);
    continued.appendCustomEntry("principal", { run: 2 });

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
      (error: unknown) =>
        error instanceof ActivationLedgerError
        && error.message.includes("must be under the ledger book"),
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
