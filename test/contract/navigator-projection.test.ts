/**
 * #959: navigator projection is prose passthrough.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFacts } from "../../src/package-contracts/terminating-tools.ts";
import {
  NAVIGATOR_OUTPUT_TOOL_NAME,
  mergePreparedAdvice,
  navigatorProseFromUnknown,
  pickPreparedProse,
  preparedAdviceFromUnknown,
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

test("navigator projection accepts bare string prose", () => {
  assert.deepEqual(projectLawfulNavigatorOutput("送 reviewer"), { prose: "送 reviewer" });
});

test("#959 prose emptiness uses trim; payload keeps original whitespace", () => {
  assert.equal(navigatorProseFromUnknown("  下一步送大理寺  \n"), "  下一步送大理寺  \n");
  assert.equal(navigatorProseFromUnknown("\n\t  \n"), undefined);
  assert.equal(navigatorProseFromUnknown(""), undefined);
});

test("#1160 pickPreparedProse selects by status; no semantic judgment", () => {
  const prepared = preparedAdviceFromUnknown({
    byStatus: {
      completed: "送 reviewer",
      unfinished: "续 apply",
      escalate: "上呈",
    },
  });
  assert.equal(pickPreparedProse(prepared, "completed"), "送 reviewer");
  assert.equal(pickPreparedProse(prepared, "unfinished"), "续 apply");
  assert.equal(pickPreparedProse(prepared, "escalate"), "上呈");
  assert.equal(pickPreparedProse(prepared, "refused"), undefined);
  assert.equal(pickPreparedProse(prepared, undefined), undefined);
  // prose-only fallback when byStatus absent
  assert.equal(pickPreparedProse(preparedAdviceFromUnknown({ prose: "单条" }), "completed"), "单条");
  assert.equal(pickPreparedProse(preparedAdviceFromUnknown({ prose: "单条" }), undefined), "单条");
  // byStatus present → no prose fallback
  assert.equal(
    pickPreparedProse(preparedAdviceFromUnknown({ byStatus: { completed: "A" }, prose: "B" }), "refused"),
    undefined,
  );
});

test("#1160 mergePreparedAdvice keeps first status key and concatenates prose", () => {
  const merged = mergePreparedAdvice(
    preparedAdviceFromUnknown({ byStatus: { completed: "first" }, prose: "p1" }),
    preparedAdviceFromUnknown({ byStatus: { completed: "second", unfinished: "u" }, prose: "p2" }),
  );
  assert.deepEqual(merged?.byStatus, { completed: "first", unfinished: "u" });
  assert.equal(merged?.prose, "p1\n\np2");
});
