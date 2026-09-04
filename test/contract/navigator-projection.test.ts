/**
 * #639 repair: navigator projection retains status into acceptedFacts.
 *
 * projectLawfulNavigatorOutput used to return { candidates } only, so the
 * ticket-trajectory / doctor-evidence consumption chain read status as
 * undefined. The projection now carries status: "advice" like the gatekeeper
 * projection carries its own status.
 *
 * Oracles: typed acceptedFacts.status only (锚定宪法).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFacts } from "../../src/package-contracts/terminating-tools.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  projectLawfulNavigatorOutput,
} from "../../src/package-contracts/navigator-output.ts";

test("navigator projection retains advice status into acceptedFacts", () => {
  const projected = projectLawfulNavigatorOutput({
    status: "advice",
    candidates: [{ next: { role: "judge", phase: null }, reason: "needs adjudication" }],
  });
  assert.ok(projected !== undefined);
  const facts = acceptedFacts(NAVIGATOR_OUTPUT_TOOL_NAME, projected);
  assert.equal(facts.status, "advice");
});

test("navigator projection rejects non-advice receipts", () => {
  assert.equal(
    projectLawfulNavigatorOutput({ status: "dispatch", candidates: [] }),
    undefined,
  );
  assert.equal(
    projectLawfulNavigatorOutput({ candidates: [] }),
    undefined,
  );
});
