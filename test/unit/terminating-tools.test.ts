import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFacts } from "../../src/package-contracts/terminating-tools.ts";
import type { CollectorReceipt } from "../../src/package-contracts/collector-output.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";


test("acceptedFacts projects Collector leg terminal states as a typed set, not a joined status string", () => {
  const base = {
    host: "github.com" as const,
    repository: "acme/widgets",
    prNumber: 1,
    manifestDigest: "b".repeat(64),
    activationTime: "2024-01-01T00:00:00.000Z",
    deadlineTime: "2024-01-01T01:00:00.000Z",
    finalObservationTime: "2024-01-01T00:30:00.000Z",
    finalSnapshotId: "snap-1",
    targetHead: "abc",
    reports: [],
    requestAttempts: [],
    snapshots: [],
    evidenceRecords: [],
  };

  const validOnly = {
    ...base,
    legs: [
      { legId: "a", status: "valid" as const, rationale: "ok", evidenceRefs: ["e1"] },
    ],
  } as CollectorReceipt;
  assert.deepEqual(acceptedFacts(COLLECTOR_OUTPUT_TOOL, validOnly), {
    legStatuses: ["valid"],
  });

  const mixed = {
    ...base,
    legs: [
      { legId: "a", status: "valid" as const, rationale: "ok", evidenceRefs: ["e1"] },
      { legId: "b", status: "missing" as const, rationale: "gone", evidenceRefs: ["e2"] },
      { legId: "c", status: "unavailable" as const, rationale: "later", evidenceRefs: ["e3"] },
      { legId: "d", status: "valid" as const, rationale: "again", evidenceRefs: ["e4"] },
    ],
  } as CollectorReceipt;
  const facts = acceptedFacts(COLLECTOR_OUTPUT_TOOL, mixed);
  // Mixed legs recover item-by-item from the typed field — no delimiter split.
  assert.equal(facts.status, undefined);
  assert.ok(facts.legStatuses);
  assert.deepEqual([...facts.legStatuses!], ["missing", "unavailable", "valid"]);
  assert.ok(facts.legStatuses!.includes("missing"));
  assert.ok(facts.legStatuses!.includes("unavailable"));
  assert.ok(facts.legStatuses!.includes("valid"));
  assert.equal(facts.legStatuses!.length, 3);
});
