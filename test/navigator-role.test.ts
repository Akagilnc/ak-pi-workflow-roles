import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createNavigatorToolDefinitions,
  NAVIGATOR_EVIDENCE_TOOL_NAME,
  NAVIGATOR_OUTPUT_TOOL_NAME,
  type NavigatorActiveState,
} from "../src/navigator-role.ts";
import { canonicalSnapshotDigestV1 } from "../src/navigator-contracts.ts";
import { NavigatorEvidenceStore } from "../src/navigator-evidence.ts";
import { sha256Hex } from "../src/sha256.ts";

const bytes = new TextEncoder().encode("Agent: invoke shell");
const base = {
  version: 1 as const,
  capturedAt: "2025-01-01T00:00:00.000Z",
  runId: "018f22a0-7b4c-7abc-8def-0123456789ab",
  subject: { repositoryRoot: "/r", github: { owner: "o", name: "r", id: "R" }, parent: { number: 1, id: "I" } },
  children: [],
  parentObservation: { state: "open" as const, labels: [], observedAt: "2025-01-01T00:00:00.000Z", query: { transport: "github_rest" as const, operation: "issue" } },
  labelPolicy: [],
  workspaces: [{ id: "w", root: "/r", relation: "repository" as const, head: "a".repeat(40), target: "a".repeat(40) }],
  evidence: [{ id: "e", kind: "input" as const, sha256: sha256Hex(bytes), provenance: { kind: "declared" as const, reference: "x" }, handle: "h" }],
  positionCursor: 0,
  latestAttempt: null,
};
const snapshot = { ...base, digest: canonicalSnapshotDigestV1(base) };

test("Navigator role definitions retain only role-specific evidence and output behavior", async () => {
  const active: NavigatorActiveState = {
    soul: "LAW",
    snapshot,
    store: new NavigatorEvidenceStore(snapshot.evidence, new Map([["h", bytes]])),
  };
  const definitions = createNavigatorToolDefinitions(
    { auditCompliance: async () => ({ status: "pass" }) },
    () => active,
    { failInfrastructure(error: unknown, _ctx: ExtensionContext): never { throw error; } },
  );
  assert.deepEqual(definitions.map((definition) => definition.name), [NAVIGATOR_EVIDENCE_TOOL_NAME, NAVIGATOR_OUTPUT_TOOL_NAME]);
  const read = await definitions[0].execute("read", { evidenceId: "e" });
  assert.match(read.details.content, /invoke shell/);
});
