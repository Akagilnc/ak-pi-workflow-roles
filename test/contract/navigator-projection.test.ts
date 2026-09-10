/**
 * #836: navigator projection is passthrough; acceptedFacts still reads status when present.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFacts } from "../../src/package-contracts/terminating-tools.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  projectLawfulNavigatorOutput,
} from "../../src/package-contracts/navigator-output.ts";

test("navigator projection retains advice status into acceptedFacts", () => {
  const input = {
    status: "advice",
    candidates: [{ next: { role: "judge", phase: null }, reason: "needs adjudication" }],
  };
  const projected = projectLawfulNavigatorOutput(input);
  assert.deepEqual(projected, input);
  const facts = acceptedFacts(NAVIGATOR_OUTPUT_TOOL_NAME, projected!);
  assert.equal(facts.status, "advice");
});

test("navigator projection keeps non-advice receipts as-is (#836)", () => {
  const dispatch = { status: "dispatch", candidates: [] };
  assert.deepEqual(projectLawfulNavigatorOutput(dispatch), dispatch);
  assert.deepEqual(projectLawfulNavigatorOutput({ candidates: [] }), { candidates: [] });
});
