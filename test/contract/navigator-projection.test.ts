/**
 * #959: navigator projection is prose passthrough.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFacts } from "../../src/package-contracts/terminating-tools.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  projectLawfulNavigatorOutput,
} from "../../src/package-contracts/navigator-output.ts";

test("navigator projection retains prose into acceptedFacts", () => {
  const input = { prose: "下一步送大理寺独立核验" };
  const projected = projectLawfulNavigatorOutput(input);
  assert.deepEqual(projected, input);
  const facts = acceptedFacts(NAVIGATOR_OUTPUT_TOOL_NAME, projected!);
  // acceptedFacts may read status when present; prose-only has no status.
  assert.equal(facts.status, undefined);
});

test("navigator projection accepts free-form object as prose body (#959)", () => {
  const freeForm = {
    role: "judge",
    command: "ak-role judge",
    reason: "应先由大理寺独立核验",
  };
  const projected = projectLawfulNavigatorOutput(freeForm);
  assert.ok(projected);
  assert.ok(projected!.prose.includes("大理寺"));
});

test("navigator projection accepts bare string prose", () => {
  assert.deepEqual(projectLawfulNavigatorOutput("送 reviewer"), { prose: "送 reviewer" });
});
