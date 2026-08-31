/**
 * #582 / ADR 0075 — ticket-provenance volume seam.
 * Public behavior: ticket-keyed append, identity idempotency, read projection, human view.
 */
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  seedGitRepository,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import {
  TICKET_PROVENANCE_KIND,
  projectTicketProvenanceEntry,
} from "../../src/ticket-provenance-contracts.ts";
import {
  appendTicketProvenanceEntry,
  readTicketProvenance,
  resolveTicketProvenanceVolume,
  ticketProvenanceEntryIdentity,
  ticketProvenanceSubject,
  writeTicketProvenanceHumanView,
} from "../../src/ticket-provenance.ts";
import { readSitianRecords } from "../../src/sitian-facade.ts";

test("ticket-provenance subject is the ticket number string", () => {
  assert.equal(ticketProvenanceSubject(582), "582");
  assert.throws(() => ticketProvenanceSubject(0));
  assert.throws(() => ticketProvenanceSubject(-1));
});

test("entry identity is stable for same source+transcript and differs otherwise", () => {
  const base = {
    ticketNumber: 582,
    sourceKind: "cc-session" as const,
    sourceRef: { sessionFile: "/s.jsonl", entryId: "u1" },
    transcript: "立文件。送司天台记录。",
  };
  const a = ticketProvenanceEntryIdentity(base);
  const b = ticketProvenanceEntryIdentity(base);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(
    a,
    ticketProvenanceEntryIdentity({ ...base, transcript: "other" }),
  );
});

test("projectTicketProvenanceEntry accepts lawful entries and rejects garbage", () => {
  const ok = projectTicketProvenanceEntry({
    basis: { method: "llm-semantic", anchors: ["#582"] },
    sourceKind: "cc-session",
    sourceRef: { sessionFile: "/x", entryId: 1 },
    transcript: "hello",
    timestamp: "2026-08-31T00:00:00.000Z",
  });
  assert.ok(ok);
  assert.equal(ok.sourceKind, "cc-session");
  assert.equal(projectTicketProvenanceEntry(null), undefined);
  assert.equal(
    projectTicketProvenanceEntry({
      basis: { method: "nope" },
      sourceKind: "cc-session",
      sourceRef: {},
      transcript: "x",
      timestamp: "t",
    }),
    undefined,
  );
});

test("append + read: ticket-keyed volume, idempotent identity, human view", async () => {
  await withHermeticHome({ prefix: "ak-ticket-prov-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    const entry = {
      basis: { method: "llm-semantic" as const, anchors: ["#582", "起居录"] },
      sourceKind: "cc-session" as const,
      sourceRef: {
        sessionFile: "/tmp/session.jsonl",
        entryId: "msg-1",
      },
      transcript: "立文件。送司天台记录。所以每个票都应该有的一份文档。",
      timestamp: "2026-08-31T12:00:00.000Z",
    };

    const ptr1 = appendTicketProvenanceEntry({
      ticketNumber: 582,
      entry,
      cwd: project,
    });
    assert.equal(ptr1.kind, TICKET_PROVENANCE_KIND);
    assert.ok(ptr1.recordFile.includes("ticket-provenance"));

    // Subject hash partition: sha256("582").slice(0,32)
    const digest = createHash("sha256").update("582").digest("hex").slice(0, 32);
    assert.ok(ptr1.recordFile.includes(digest));

    const ptr2 = appendTicketProvenanceEntry({
      ticketNumber: 582,
      entry,
      cwd: project,
    });
    assert.equal(ptr2.identity, ptr1.identity);
    assert.equal(ptr2.recordFile, ptr1.recordFile);

    const raw = await readSitianRecords(ptr1.recordFile);
    assert.equal(raw.records.length, 1, "identity hit must not re-append");

    // Distinct transcript → second row
    const entry2 = {
      ...entry,
      transcript: "起居录的生成我觉得应该是一个机械角色/llm角色。 起居郎",
      sourceRef: { sessionFile: "/tmp/session.jsonl", entryId: "msg-2" },
      timestamp: "2026-08-31T12:01:00.000Z",
    };
    appendTicketProvenanceEntry({
      ticketNumber: 582,
      entry: entry2,
      cwd: project,
    });

    const read = await readTicketProvenance(582, project);
    assert.equal(read.entries.length, 2);
    assert.equal(read.entries[0]!.transcript, entry.transcript);
    assert.equal(read.entries[1]!.sourceRef.entryId, "msg-2");

    const volume = resolveTicketProvenanceVolume(582, project);
    assert.equal(volume.recordFile, ptr1.recordFile);

    const humanPath = writeTicketProvenanceHumanView({
      ticketNumber: 582,
      cwd: project,
      entries: read.entries,
    });
    // External contract only: derived face path co-located and present.
    // No generated-text observation (生成物禁机械依赖).
    assert.equal(humanPath, volume.humanViewFile);
    await access(humanPath);
  });
});

test("readTicketProvenance skips quote-verify-failed diagnostics and foreign kinds", async () => {
  await withHermeticHome({ prefix: "ak-ticket-prov-skip-" }, async ({ home }) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);

    appendTicketProvenanceEntry({
      ticketNumber: 7,
      cwd: project,
      entry: {
        basis: {
          method: "quote-verify-failed",
          note: "spliced quote",
        },
        sourceKind: "cc-session",
        sourceRef: { sessionFile: "/s", entryId: "x" },
        transcript: "not a real diary row for readers",
        timestamp: "2026-08-31T00:00:00.000Z",
      },
    });
    appendTicketProvenanceEntry({
      ticketNumber: 7,
      cwd: project,
      entry: {
        basis: { method: "llm-semantic" },
        sourceKind: "issue-body-comment",
        sourceRef: { url: "https://github.com/x/y/issues/7" },
        transcript: "owner decree block",
        timestamp: "2026-08-31T00:01:00.000Z",
      },
    });

    const read = await readTicketProvenance(7, project);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0]!.transcript, "owner decree block");
    assert.ok(read.skipped >= 1);
  });
});
