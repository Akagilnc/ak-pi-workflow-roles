import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedDetailsContractError,
  acceptedFacts,
  validateAcceptedDetails,
} from "../../src/package-contracts/terminating-tools.ts";
import type { CollectorReceipt } from "../../src/package-contracts/collector-output.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";

test("accepted-details validation distinguishes contract rejection from unexpected validator failure", () => {
  assert.throws(
    () => validateAcceptedDetails("ak_coder_output", {}),
    AcceptedDetailsContractError,
  );

  const failure = new TypeError("validator implementation failed");
  const hostileDetails = new Proxy({}, {
    ownKeys() { throw failure; },
  });
  assert.throws(
    () => validateAcceptedDetails("ak_coder_output", hostileDetails),
    (error) => error === failure,
  );
});

test("acceptedFacts projects nonempty Collector status from typed leg terminal states", () => {
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
  assert.deepEqual(acceptedFacts(COLLECTOR_OUTPUT_TOOL, validOnly), { status: "valid" });

  const mixed = {
    ...base,
    legs: [
      { legId: "a", status: "valid" as const, rationale: "ok", evidenceRefs: ["e1"] },
      { legId: "b", status: "missing" as const, rationale: "gone", evidenceRefs: ["e2"] },
      { legId: "c", status: "unavailable" as const, rationale: "later", evidenceRefs: ["e3"] },
    ],
  } as CollectorReceipt;
  assert.deepEqual(acceptedFacts(COLLECTOR_OUTPUT_TOOL, mixed), {
    status: "missing+unavailable+valid",
  });
});
