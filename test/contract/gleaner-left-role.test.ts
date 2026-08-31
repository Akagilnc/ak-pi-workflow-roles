/**
 * #502 左拾遗 — typed 弹章 at the recorded-output seam.
 * Empty 弹章 is lawful completion; nonempty 弹章 carries pointer + statement
 * as typed fields. No bounce/verdict channel (言不为狱).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  gleanerLeftDecisiveFacts,
  validateRecordedGleanerLeftOutput,
} from "../../src/gleaner-left-contracts.ts";
import { gleanerLeftOutputSchema } from "../../src/gleaner-left-role.ts";
import { MAIN_ROLE_SESSION_MATERIALS } from "../../src/session-opening-materials.ts";
import { ONE_SHOT_ROLES, PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { AUTOMATIC_CONFIGURABLE_SEATS } from "../../src/public-cli/registry.ts";
import { GATE_OFFICER_SEATS } from "../../src/public-cli/config.ts";

test("gleaner-left is a callable one-shot seat with unanchored materials", () => {
  const record = PACKAGED_ROLE_REGISTRY.find((entry) => entry.role === "gleaner-left");
  assert.ok(record);
  assert.equal(record.outputTool, GLEANER_LEFT_OUTPUT_TOOL_NAME);
  assert.deepEqual(
    [...MAIN_ROLE_SESSION_MATERIALS["gleaner-left"]],
    ["CLAUDE.md", "souls/gleaner-left.md", "souls/quality-law.md"],
  );
  assert.equal(ONE_SHOT_ROLES.includes("gleaner-left"), true);
  assert.equal(
    (AUTOMATIC_CONFIGURABLE_SEATS as readonly string[]).includes("gleaner-left"),
    false,
  );
  assert.equal((GATE_OFFICER_SEATS as readonly string[]).includes("gleaner-left"), false);
});

test("output schema advertises pointer and statement as typed 弹章 fields", () => {
  const properties = (gleanerLeftOutputSchema as { properties?: Record<string, unknown> })
    .properties;
  assert.ok(properties);
  assert.ok("status" in properties);
  assert.ok("findings" in properties);
  const findings = properties.findings as {
    items?: { properties?: Record<string, unknown> };
  };
  assert.ok(findings.items?.properties);
  assert.ok("pointer" in findings.items.properties);
  assert.ok("statement" in findings.items.properties);
});

test("empty 弹章 is a lawful completed recorded output", () => {
  const recorded = validateRecordedGleanerLeftOutput({
    status: "completed",
    findings: [],
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.findings, []);
  assert.deepEqual(gleanerLeftDecisiveFacts(recorded).findings, []);
});

test("nonempty 弹章 records pointer and statement as typed fields", () => {
  const recorded = validateRecordedGleanerLeftOutput({
    status: "completed",
    findings: [
      {
        pointer: "src/packaged-role-registry.ts:22",
        statement: "公开角色表未收编左拾遗",
      },
    ],
  });
  assert.equal(recorded.status, "completed");
  assert.equal(recorded.findings.length, 1);
  assert.equal(recorded.findings[0]?.pointer, "src/packaged-role-registry.ts:22");
  assert.equal(recorded.findings[0]?.statement, "公开角色表未收编左拾遗");
  const facts = gleanerLeftDecisiveFacts(recorded);
  const findings = facts.findings as readonly { pointer: string; statement: string }[];
  assert.equal(findings[0]?.pointer, "src/packaged-role-registry.ts:22");
  assert.equal(findings[0]?.statement, "公开角色表未收编左拾遗");
});

test("recorded output does not recognize bounce or verdict statuses", () => {
  assert.throws(() => validateRecordedGleanerLeftOutput({ status: "bounce" }));
  assert.throws(() => validateRecordedGleanerLeftOutput({ status: "pass" }));
  assert.throws(() =>
    validateRecordedGleanerLeftOutput({ countersignStatus: "converged" }),
  );
  assert.throws(() => validateRecordedGleanerLeftOutput(null));
});
