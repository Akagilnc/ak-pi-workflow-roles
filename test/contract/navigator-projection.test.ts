/**
 * #959: navigator projection is prose passthrough.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFacts, type AcceptedDetails } from "../../src/package-contracts/terminating-tools.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  navigatorProseFromUnknown,
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

test("historical review receipts retain their recorded decision", () => {
  assert.deepEqual(acceptedFacts("ak_judge_output", { judgeStatus: "converged" } as unknown as AcceptedDetails), { status: "converged" });
  assert.deepEqual(acceptedFacts("ak_countersign_output", { countersignStatus: "converged" } as unknown as AcceptedDetails), { status: "converged" });
  for (const tool of ["ak_notary_output", "ak_inspector_output", "ak_auditor_output"]) {
    assert.deepEqual(acceptedFacts(tool, { status: "continue" }), { status: "continue" });
  }
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

test("#959 prose emptiness uses trim; payload keeps original whitespace", () => {
  assert.equal(navigatorProseFromUnknown("  下一步送大理寺  \n"), "  下一步送大理寺  \n");
  assert.equal(navigatorProseFromUnknown("\n\t  \n"), undefined);
  assert.equal(navigatorProseFromUnknown(""), undefined);
});
