/**
 * #502 左拾遗 — registry binding + recorded-output discriminator boundary.
 * Empty/nonempty 弹章 typed Terminal behavior is owned by the public CLI tracer.
 * No bounce/verdict channel (言不为狱).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  validateRecordedGleanerLeftOutput,
} from "../../src/gleaner-left-contracts.ts";
import { MAIN_ROLE_SESSION_MATERIALS } from "../../src/session-opening-materials.ts";
import { ONE_SHOT_ROLES, PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { GATE_OFFICER_SEATS } from "../../src/public-cli/config.ts";

test("gleaner-left is a callable seat with unanchored materials (resume allowed)", () => {
  const record = PACKAGED_ROLE_REGISTRY.find((entry) => entry.role === "gleaner-left");
  assert.ok(record);
  assert.equal(record.outputTool, GLEANER_LEFT_OUTPUT_TOOL_NAME);
  assert.deepEqual(
    [...MAIN_ROLE_SESSION_MATERIALS["gleaner-left"]],
    ["CLAUDE.md", "souls/gleaner-left.md", "souls/quality-law.md"],
  );
  assert.equal(ONE_SHOT_ROLES.includes("gleaner-left"), false);
  assert.equal((GATE_OFFICER_SEATS as readonly string[]).includes("gleaner-left"), false);
});

test("recorded output does not recognize bounce or verdict statuses", () => {
  assert.throws(() => validateRecordedGleanerLeftOutput({ status: "bounce" }));
  assert.throws(() => validateRecordedGleanerLeftOutput({ status: "pass" }));
  assert.throws(() =>
    validateRecordedGleanerLeftOutput({ countersignStatus: "converged" }),
  );
  assert.throws(() => validateRecordedGleanerLeftOutput(null));
  // completed is the sole lawful discriminator (empty 弹章 still completes).
  const recorded = validateRecordedGleanerLeftOutput({
    status: "completed",
    findings: [],
  });
  assert.equal(recorded.status, "completed");
});
