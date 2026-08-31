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
  markdownFenceFor,
  renderTicketProvenanceMarkdown,
  ticketProvenanceEntryIdentity,
  ticketProvenanceSubject,
} from "../../src/ticket-provenance.ts";

test("ticket-provenance subject is the ticket number string", () => {
  assert.equal(ticketProvenanceSubject(582), "582");
  assert.throws(() => ticketProvenanceSubject(0));
  assert.throws(() => ticketProvenanceSubject(-1));
});

test("markdown fence outruns any backtick run inside the transcript", () => {
  assert.equal(markdownFenceFor("plain"), "```");
  assert.equal(markdownFenceFor("has ``` inside"), "````");
  assert.equal(markdownFenceFor("nest ```` four"), "`````");
  const transcript = ["before", "```js", "code()", "```", "after"].join("\n");
  const md = renderTicketProvenanceMarkdown({
    ticketNumber: 582,
    entries: [
      {
        basis: { method: "llm-semantic", anchors: ["#582"] },
        sourceKind: "cc-session",
        sourceRef: { sessionFile: "/s", entryId: "1" },
        transcript,
        timestamp: "2026-08-31T00:00:00.000Z",
      },
    ],
  });
  // Opening/closing fence must be longer than any run in the body so the
  // transcript cannot break the human-view block structure.
  const fence = markdownFenceFor(transcript);
  assert.ok(md.includes(`\n${fence}\n${transcript}\n${fence}\n`));
  assert.equal(fence.startsWith("```"), true);
  assert.ok(fence.length > 3);
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
  // collector-failed is not a lawful body entry method.
  assert.equal(
    projectTicketProvenanceEntry({
      basis: { method: "collector-failed", note: "old fail" },
      sourceKind: "cc-session",
      sourceRef: { path: "x" },
      transcript: "old fail",
      timestamp: "2026-08-31T00:00:00.000Z",
    }),
    undefined,
  );
});
