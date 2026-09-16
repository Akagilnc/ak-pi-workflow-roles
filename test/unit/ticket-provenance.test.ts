/**
 * #901 / ADR 0075 — pure ticket-provenance projectors (no fs/git).
 * Medium reproject proofs live under test/integration/public-cli-diarist-run.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  projectTicketProvenanceHeader,
  projectTicketProvenanceLine,
  projectTicketProvenanceSessions,
} from "../../src/ticket-provenance-contracts.ts";
import { ticketProvenanceSubject } from "../../src/ticket-provenance.ts";
import {
  projectDiaristSessions,
} from "../../src/diarist-contracts.ts";

test("ticket-provenance subject is the ticket number string", () => {
  assert.equal(ticketProvenanceSubject(582), "582");
  assert.throws(() => ticketProvenanceSubject(0));
  assert.throws(() => ticketProvenanceSubject(-1));
});

test("projectTicketProvenanceSessions: empty is lawful; malformed is absent", () => {
  assert.deepEqual(projectTicketProvenanceSessions([]), []);
  assert.equal(projectTicketProvenanceSessions(null), undefined);
  assert.equal(projectTicketProvenanceSessions("x"), undefined);
  assert.equal(
    projectTicketProvenanceSessions([{ path: "", ranges: [{ from: { line: 1 }, to: { line: 2 } }] }]),
    undefined,
  );
  assert.equal(
    projectTicketProvenanceSessions([
      { path: "/s.jsonl", ranges: [{ from: {}, to: { line: 2 } }] },
    ]),
    undefined,
  );
  const ok = projectTicketProvenanceSessions([
    {
      path: "/s.jsonl",
      ranges: [{ from: { id: "a" }, to: { line: 9 } }],
    },
  ]);
  assert.deepEqual(ok, [
    {
      path: "/s.jsonl",
      ranges: [{ from: { id: "a" }, to: { line: 9 } }],
    },
  ]);
});

test("projectTicketProvenanceHeader and line round-trip the diary shape", () => {
  const header = projectTicketProvenanceHeader({
    repo: "demo",
    ticket: 900,
    createdAt: "t0",
    updatedAt: "t1",
    sessions: [{ path: "/s", ranges: [{ from: { line: 1 }, to: { line: 2 } }] }],
  });
  assert.ok(header);
  assert.equal(header.ticket, 900);
  assert.equal(header.sessions.length, 1);
  // Lawful empty sessions stay empty — distinct from malformed below.
  const emptySessions = projectTicketProvenanceHeader({
    repo: "demo",
    ticket: 900,
    createdAt: "t0",
    updatedAt: "t1",
    sessions: [],
  });
  assert.ok(emptySessions);
  assert.deepEqual(emptySessions.sessions, []);
  // Damaged sessions metadata is not washed into lawful empty (失败诚实).
  assert.equal(
    projectTicketProvenanceHeader({
      repo: "demo",
      ticket: 900,
      createdAt: "t0",
      updatedAt: "t1",
      sessions: "not-an-array",
    }),
    undefined,
  );
  assert.equal(
    projectTicketProvenanceHeader({
      repo: "demo",
      ticket: 900,
      createdAt: "t0",
      updatedAt: "t1",
      sessions: [{ path: "", ranges: [{ from: { line: 1 }, to: { line: 2 } }] }],
    }),
    undefined,
  );

  const line = projectTicketProvenanceLine({
    speaker: "runner",
    s: 0,
    sourcePosition: 7,
    id: "m1",
    text: "hi",
  });
  assert.deepEqual(line, {
    speaker: "runner",
    s: 0,
    sourcePosition: 7,
    id: "m1",
    text: "hi",
  });
  assert.equal(projectTicketProvenanceLine({ speaker: "x", s: 0, text: "t" }), undefined);
});

test("projectDiaristSessions: absent field is empty, not rejection", () => {
  assert.deepEqual(projectDiaristSessions({}), []);
  assert.equal(
    projectDiaristSessions({ sessions: [{ path: "/s", ranges: [] }] }),
    undefined,
  );
});
