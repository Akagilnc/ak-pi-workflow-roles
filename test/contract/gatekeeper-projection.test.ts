/**
 * #836: projectLawfulGatekeeperOutput is passthrough — no field drop / filter.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { projectLawfulGatekeeperOutput } from "../../src/package-contracts/gatekeeper-output.ts";

test("gatekeeper projection keeps original findings payload as-is (#836)", () => {
  const input = {
    status: "pass",
    findings: ["ok", 7, null, { x: 1 }],
    extra: "kept",
  };
  assert.deepEqual(projectLawfulGatekeeperOutput(input), input);
});
