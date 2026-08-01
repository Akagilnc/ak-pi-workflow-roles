import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadNavigatorEvidence,
  MAX_NAVIGATOR_EVIDENCE_BYTES,
  MAX_NAVIGATOR_EVIDENCE_ITEMS,
} from "../extensions/role-runtime.ts";
import type { CurrentPositionSnapshotV1 } from "../src/navigator-contracts.ts";

const runId = "018f22a0-7b4c-7abc-8def-0123456789ab";

async function fixture(byteLength: number) {
  const root = await mkdtemp(join(tmpdir(), "navigator-evidence-budget-"));
  const evidenceRoot = join(root, ".ak", "work", "issues", "28", "assisted", runId, "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const handle = join(evidenceRoot, "shared");
  await writeFile(handle, new Uint8Array(byteLength));
  const snapshot = {
    subject: { repositoryRoot: root, parent: { number: 28 } },
    runId,
    evidence: [],
  } as unknown as CurrentPositionSnapshotV1;
  return { handle, snapshot };
}

function evidence(handle: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `e${index}`, handle })) as CurrentPositionSnapshotV1["evidence"];
}

test("Navigator host bounds evidence item count before loading handles", async () => {
  const { handle, snapshot } = await fixture(0);
  snapshot.evidence = evidence(handle, MAX_NAVIGATOR_EVIDENCE_ITEMS + 1);
  await assert.rejects(loadNavigatorEvidence(snapshot), /item count/i);
});

test("Navigator host bounds aggregate admitted bytes", async () => {
  const itemBytes = 8 * 1024 * 1024;
  const { handle, snapshot } = await fixture(itemBytes);
  snapshot.evidence = evidence(handle, Math.floor(MAX_NAVIGATOR_EVIDENCE_BYTES / itemBytes) + 1);
  await assert.rejects(loadNavigatorEvidence(snapshot), /aggregate byte/i);
});
