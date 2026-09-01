import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveInstitutionalSeatSelections,
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
  assert.deepEqual(page3.seats.navigator, parentSelection);

  // Auditor / evidenceChild always inherit parent effective — never seat override.
  // Navigator: explicit config seat wins over parent effective (#590).
  const page4 = resolveInstitutionalSeatSelections(emptyConfig(), parentSelection);
  assert.deepEqual(page4.seats.auditor, parentSelection);
  assert.deepEqual(page4.seats.evidenceChild, parentSelection);
  assert.deepEqual(page4.seats.navigator, parentSelection);

  const page5 = resolveInstitutionalSeatSelections({
    seats: {
      navigator: { provider: "nav-p", model: "nav-m", thinking: "max" },
    },
  }, parentSelection);
  assert.deepEqual(page5.seats.navigator, { provider: "nav-p", model: "nav-m", thinking: "max" });
});

test("resolution page shape carries a stable versioned seats envelope", () => {
  const page: InstitutionalResolutionPage = resolveInstitutionalSeatSelections(
    { seats: {} },
    { provider: "p", model: "m" },
  );
  assert.equal(page.version, 1);
  assert.deepEqual(page.seats.gatekeeper, { provider: "p", model: "m" });
  assert.deepEqual(page.seats.evidenceChild, { provider: "p", model: "m" });
});
