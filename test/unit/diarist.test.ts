/**
 * #779 — diarist entry projection + commit facts shape (no frozen catalog).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { projectDiaristEntries } from "../../src/diarist-contracts.ts";
import { extractReferencedAdrPaths } from "../../src/adr-path-refs.ts";

test("projectDiaristEntries keeps lawful whole blocks and drops garbage rows", () => {
  const rows = projectDiaristEntries({
    entries: [
      {
        sourceKind: "cc-session",
        sourceRef: { sessionFile: "/s.jsonl", entryId: "u1" },
        transcript: "调用方无感",
        timestamp: "2026-09-08T00:00:00.000Z",
        note: "owner",
      },
      { sourceKind: "cc-session" }, // missing transcript
      null,
      "noise",
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.transcript, "调用方无感");
  assert.equal(rows[0]!.sourceRef.sessionFile, "/s.jsonl");
  assert.equal(projectDiaristEntries({}).length, 0);
  assert.equal(projectDiaristEntries(null).length, 0);
});

test("extractReferencedAdrPaths keeps docs/adr shapes; drops traversal claims", () => {
  assert.deepEqual(
    extractReferencedAdrPaths(
      "see docs/adr/0075-ticket-provenance-diarist-pipeline.md and docs/adr/sub/a.md",
    ),
    [
      "docs/adr/0075-ticket-provenance-diarist-pipeline.md",
      "docs/adr/sub/a.md",
    ],
  );
  // Traversal / non-ADR claims are not path references (shape, not IO confinement).
  assert.deepEqual(
    extractReferencedAdrPaths(
      "docs/adr/x/../../README.md docs/adr/../secrets.md docs/other/x.md",
    ),
    [],
  );
});
