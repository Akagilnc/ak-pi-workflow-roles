/**
 * #502 左拾遗 — typed 弹章 contract at the recorded-output seam.
 * Empty 弹章 is lawful completion; nonempty 弹章 carries pointer + statement.
 * No bounce/verdict channel (言不为狱).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GLEANER_LEFT_OUTPUT_TOOL_NAME,
  validateRecordedGleanerLeftOutput,
} from "../../src/gleaner-left-contracts.ts";
import { createGleanerLeftRoleRuntime } from "../../src/role-runtime.ts";

function gleanerLeftHarness() {
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const roleHost = {
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) {
      if (event === "before_agent_start") beforeStart = handler;
    },
    getAllTools() {
      return [{ name: GLEANER_LEFT_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }];
    },
  };
  return { tools, roleHost, beforeStart: () => beforeStart };
}

test("empty 弹章 is a lawful completed recorded output", () => {
  const recorded = validateRecordedGleanerLeftOutput({
    status: "completed",
    findings: [],
  });
  assert.equal(recorded.status, "completed");
  assert.deepEqual(recorded.findings, []);
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
});

test("recorded output does not recognize bounce or verdict statuses", () => {
  assert.throws(() => validateRecordedGleanerLeftOutput({ status: "bounce" }));
  assert.throws(() => validateRecordedGleanerLeftOutput({ status: "pass" }));
  assert.throws(() =>
    validateRecordedGleanerLeftOutput({ countersignStatus: "converged" }),
  );
  assert.throws(() => validateRecordedGleanerLeftOutput(null));
});

test("runtime registers output tool and injects soul without ticket body preload", async () => {
  const h = gleanerLeftHarness();
  const runtime = createGleanerLeftRoleRuntime(h.roleHost as never, {
    loadSoul: async () => "GLEANER LEFT LAW",
  });
  await runtime.activate();
  assert.ok(h.tools.has(GLEANER_LEFT_OUTPUT_TOOL_NAME));
  assert.ok(h.beforeStart());

  const prompted = h.beforeStart()!({ systemPrompt: "BASE" }) as {
    systemPrompt: string;
  };
  // Soul-only injection: no ticket/docket preload (无锚定).
  assert.ok(prompted.systemPrompt.length > "BASE".length);
});

test("execute accepts as-is and terminates — sole-final barrier is ledger-owned", async () => {
  const h = gleanerLeftHarness();
  const runtime = createGleanerLeftRoleRuntime(h.roleHost as never, {
    loadSoul: async () => "LAW",
  });
  await runtime.activate();
  const tool = h.tools.get(GLEANER_LEFT_OUTPUT_TOOL_NAME);
  assert.ok(tool);

  const empty = await tool.execute(
    "empty",
    { status: "completed", findings: [] },
    undefined,
    undefined,
    {},
  );
  assert.equal(empty.terminate, true);
  assert.deepEqual(empty.details, { status: "completed", findings: [] });

  const memorial = await tool.execute(
    "memorial",
    {
      status: "completed",
      findings: [{ pointer: "src/foo.ts:1", statement: "疑点" }],
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(memorial.terminate, true);
  assert.equal(
    (memorial.details as { findings: readonly { pointer: string }[] }).findings[0]
      ?.pointer,
    "src/foo.ts:1",
  );
});
