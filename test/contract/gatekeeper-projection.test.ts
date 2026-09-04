/**
 * #639 repair: gatekeeper package-contract projection filters findings to strings.
 *
 * projectLawfulGatekeeperOutput must preserve prior province asStringArray behavior
 * when DRY'd into the shared contract — mixed arrays must not leak non-strings.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { projectLawfulGatekeeperOutput } from "../../src/package-contracts/gatekeeper-output.ts";

test("gatekeeper projection filters mixed findings to strings only", () => {
  const projected = projectLawfulGatekeeperOutput({
    status: "pass",
    findings: ["ok", 7, null, { x: 1 }],
  });
  assert.deepEqual(projected, { status: "pass", findings: ["ok"] });
});
