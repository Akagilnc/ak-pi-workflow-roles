import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INSTITUTIONAL_RESOLUTION_FILE,
  readInstitutionalSeatSelection,
  resolveInstitutionalSeatSelections,
  writeInstitutionalResolutionPage,
  InstitutionalResolutionError,
  type InstitutionalResolutionPage,
} from "../../src/institutional-resolution.ts";
import type { PublicCliConfig } from "../../src/public-cli/config.ts";

function emptyConfig(): PublicCliConfig {
  return {
    seats: {},
  };
}

test("selection priority shortest boundary: seat override > gatekeeper fallback > parent effective", () => {
  const parentSelection = { provider: "parent-provider", model: "parent-model", thinking: "off" };

  // Case 1: Seat override wins
  const configWithSeatOverride: PublicCliConfig = {
    seats: {
      inspector: { provider: "seat-p", model: "seat-m", thinking: "high" },
      gatekeeper: { provider: "gate-p", model: "gate-m" },
    },
  };
  const page1 = resolveInstitutionalSeatSelections(configWithSeatOverride, parentSelection);
  assert.deepEqual(page1.seats.inspector, { provider: "seat-p", model: "seat-m", thinking: "high" });

  // Case 2: Gatekeeper fallback wins when own seat is unconfigured
  const configWithGateOverride: PublicCliConfig = {
    seats: {
      gatekeeper: { provider: "gate-p", model: "gate-m", thinking: "low" },
    },
  };
  const page2 = resolveInstitutionalSeatSelections(configWithGateOverride, parentSelection);
  assert.deepEqual(page2.seats.inspector, { provider: "gate-p", model: "gate-m", thinking: "low" });
  assert.deepEqual(page2.seats.notary, { provider: "gate-p", model: "gate-m", thinking: "low" });
  assert.deepEqual(page2.seats.gatekeeper, { provider: "gate-p", model: "gate-m", thinking: "low" });

  // Case 3: Parent effective selection when neither seat nor gatekeeper override exists
  const configEmpty = emptyConfig();
  const page3 = resolveInstitutionalSeatSelections(configEmpty, parentSelection);
  assert.deepEqual(page3.seats.inspector, parentSelection);
  assert.deepEqual(page3.seats.notary, parentSelection);
  assert.deepEqual(page3.seats.gatekeeper, parentSelection);
  assert.deepEqual(page3.seats.auditor, parentSelection);
  assert.deepEqual(page3.seats.evidenceChild, parentSelection);
});

test("resolution page write, read, corruption, and resume rewrite", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ak-test-resolution-page-"));
  try {
    const pageV1: InstitutionalResolutionPage = {
      version: 1,
      seats: {
        gatekeeper: { provider: "prov-1", model: "mod-1" },
        inspector: { provider: "prov-1", model: "mod-1" },
        notary: { provider: "prov-1", model: "mod-1" },
      },
    };

    // 1. Write and read
    await writeInstitutionalResolutionPage(runDir, pageV1);
    const readGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(readGatekeeper, { provider: "prov-1", model: "mod-1" });

    // 2. Missing seat in existing page throws typed error
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDir, "auditor"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );

    // 3. Resume rewrite updates page
    const pageV2: InstitutionalResolutionPage = {
      version: 1,
      seats: {
        gatekeeper: { provider: "prov-2", model: "mod-2", thinking: "high" },
        inspector: { provider: "prov-2", model: "mod-2", thinking: "high" },
        notary: { provider: "prov-2", model: "mod-2", thinking: "high" },
        auditor: { provider: "prov-2", model: "mod-2", thinking: "high" },
      },
    };
    await writeInstitutionalResolutionPage(runDir, pageV2);
    const readAfterResume = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(readAfterResume, { provider: "prov-2", model: "mod-2", thinking: "high" });

    // 4. Corrupted page throws typed error
    await writeFile(join(runDir, INSTITUTIONAL_RESOLUTION_FILE), "not valid json {{{{", "utf8");
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDir, "gatekeeper"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );

    // 5. Missing runDir / missing page throws typed error
    const missingRunDir = join(runDir, "does-not-exist");
    await assert.rejects(
      () => readInstitutionalSeatSelection(missingRunDir, "gatekeeper"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
