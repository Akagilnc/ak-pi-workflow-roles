/**
 * #901 / ADR 0075 — pure ticket-provenance projectors (no fs/git).
 * Medium reproject proofs live under test/integration/public-cli-diarist-run.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { projectTicketProvenanceSessions } from "../../src/ticket-provenance-contracts.ts";
import {
  projectDiaristSessions,
} from "../../src/diarist-contracts.ts";


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

test("projectDiaristSessions: absent field is empty, not rejection", () => {
  assert.deepEqual(projectDiaristSessions({}), []);
  assert.equal(
    projectDiaristSessions({ sessions: [{ path: "/s", ranges: [] }] }),
    undefined,
  );
});
