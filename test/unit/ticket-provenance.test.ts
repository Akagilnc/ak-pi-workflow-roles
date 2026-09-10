/**
 * #582 / ADR 0075 — pure ticket-provenance projectors / identity (no fs/git).
 * Medium append/read volume proofs live under test/integration/diarist-run.test.ts
 * and public-cli-countersign-run.test.ts (real entry).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
  projectTicketProvenanceDiagnostic,
  projectTicketProvenanceEntry,
} from "../../src/ticket-provenance-contracts.ts";
import {
  ticketProvenanceEntryIdentity,
  ticketProvenanceSubject,
} from "../../src/ticket-provenance.ts";
import { projectDiaristEntries } from "../../src/diarist-contracts.ts";

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

test("projectTicketProvenanceEntry keeps original entries; only non-objects are absent", () => {
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
  const unknownMethod = projectTicketProvenanceEntry({
    basis: { method: "nope" },
    sourceKind: "cc-session",
    sourceRef: {},
    transcript: "x",
    timestamp: "t",
  });
  assert.deepEqual(unknownMethod, {
    basis: { method: "nope" },
    sourceKind: "cc-session",
    sourceRef: {},
    transcript: "x",
    timestamp: "t",
  });
  const extra = {
    basis: { method: "llm-semantic" },
    sourceKind: "cc-session",
    sourceRef: { path: "/x", extraRef: 9 },
    transcript: "hello",
    timestamp: "t",
    extra: { kept: true },
  };
  assert.deepEqual(projectTicketProvenanceEntry(extra), extra);
  assert.equal(projectTicketProvenanceEntry({ original: "raw-row", unprojected: true }), undefined);
});

test("diagnostic projection: recordClass payload only; forged disguise rejected", () => {
  const ok = projectTicketProvenanceDiagnostic({
    recordClass: TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
    diagnosticKind: "collector-failed",
    cause: "engine down",
    recordedAt: "2026-08-31T00:00:00.000Z",
  });
  assert.ok(ok);
  assert.equal(ok.diagnosticKind, "collector-failed");
  // Entry projector must not accept diagnostic payload as body.
  assert.equal(
    projectTicketProvenanceEntry({
      recordClass: TICKET_PROVENANCE_RECORD_CLASS_DIAGNOSTIC,
      diagnosticKind: "collector-failed",
      cause: "engine down",
      recordedAt: "2026-08-31T00:00:00.000Z",
    }),
    undefined,
  );
  // Branch-intermediate disguised shape is not a product diagnostic contract.
  assert.equal(
    projectTicketProvenanceDiagnostic({
      basis: { method: "collector-failed", note: "old fail" },
      sourceKind: "cc-session",
      sourceRef: { path: "x" },
      transcript: "old fail",
      timestamp: "2026-08-31T00:00:00.000Z",
    }),
    undefined,
  );
  // Unknown method is still a body entry — no allowlist drop (#836 B6.9).
  const kept = projectTicketProvenanceEntry({
    basis: { method: "collector-failed", note: "old fail" },
    sourceKind: "cc-session",
    sourceRef: { path: "x" },
    transcript: "old fail",
    timestamp: "2026-08-31T00:00:00.000Z",
  });
  assert.deepEqual(kept, {
    basis: { method: "collector-failed", note: "old fail" },
    sourceKind: "cc-session",
    sourceRef: { path: "x" },
    transcript: "old fail",
    timestamp: "2026-08-31T00:00:00.000Z",
  });
});

test("projectDiaristEntries keeps original rows including extra fields and non-objects", () => {
  const rows = [
    {
      sourceKind: "cc-session",
      sourceRef: { path: "/a", extraRef: 1 },
      transcript: "t",
      timestamp: "ts",
      extra: "kept",
    },
    "bare-string",
    7,
  ];
  assert.deepEqual(projectDiaristEntries({ entries: rows, ignored: true }), rows);
  assert.deepEqual(projectDiaristEntries({}), []);
});
