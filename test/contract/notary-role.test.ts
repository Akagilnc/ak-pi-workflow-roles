import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  NOTARY_OUTPUT_TOOL_NAME,
  projectLawfulNotaryOutput,
  retainNotarySubmission,
} from "../../src/notary-contracts.ts";
import { createNotaryRoleRuntime } from "../../src/notary-role.ts";

const LOCATOR = {
  runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
  runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
  role: "judge",
} as const;

/** Shared mock-Pi harness for the Notary runtime (reused by both contract tests). */
function notaryHarness() {
  const flags = new Map<string, string>();
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const pi = {
    registerFlag(name: string) { flags.set(name, ""); },
    getFlag(name: string) { return flags.get(name); },
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) { if (event === "before_agent_start") beforeStart = handler; },
    getAllTools() { return [{ name: NOTARY_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }]; },
  };
  return { flags, tools, pi, beforeStart: () => beforeStart };
}

test("projectLawfulNotaryOutput projects pass/bounce; non-release retained as-is", () => {
  assert.equal(projectLawfulNotaryOutput({ status: "pass", findings: [] })?.status, "pass");
  const bounce = projectLawfulNotaryOutput({ status: "bounce", findings: ["x"] });
  assert.equal(bounce?.status, "bounce");
  // ADR 0055 / 第 0 条: no shape admission throw — non-release stays undefined projection.
  assert.equal(projectLawfulNotaryOutput({ status: "incomplete", reason: "missing draft" }), undefined);
  assert.equal(projectLawfulNotaryOutput({ status: "maybe" }), undefined);
  assert.equal(projectLawfulNotaryOutput(null), undefined);
  const raw = { status: "maybe", note: "not an explicit release" };
  assert.deepEqual(retainNotarySubmission(raw), raw);
});

test("Notary runtime registers output tool and binds source-run locator without draft body", async () => {
  const h = notaryHarness();
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    { failInfrastructure(error) { throw error; } },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  await runtime.activate();
  assert.ok(h.tools.has(NOTARY_OUTPUT_TOOL_NAME));
  assert.ok(h.beforeStart());

  const prompted = h.beforeStart()!({ systemPrompt: "BASE" }) as {
    systemPrompt: string;
  };
  // Locator-only contract: bound identity is present as structured JSON; no draft body preload key.
  assert.equal(prompted.systemPrompt.includes(JSON.stringify({ sourceRun: LOCATOR })), true);
  assert.equal(prompted.systemPrompt.includes("judge_draft"), false);
  assert.equal(prompted.systemPrompt.includes('"material"'), false);
});

test("Notary output routes an infrastructure-failure declaration to the host before any projection", async () => {
  const h = notaryHarness();
  let hostCalls = 0;
  const runtime = createNotaryRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "NOTARY LAW", loadSourceRunLocator: async () => LOCATOR },
    {
      failInfrastructure(error: unknown, _ctx: unknown, id?: string) {
        hostCalls += 1;
        assert.equal(id, "infra");
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
  );
  h.flags.set("ak-notary-source-run", LOCATOR.runDirectory);
  await runtime.activate();
  const tool = h.tools.get(NOTARY_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "infra", name: NOTARY_OUTPUT_TOOL_NAME, arguments: {} }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  });
  const parameters = { infrastructureFailure: { diagnostic: "notary engine 541" } };
  await assert.rejects(
    tool.execute("infra", parameters, undefined, undefined, { sessionManager }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "notary engine 541");
      return true;
    },
  );
  assert.equal(hostCalls, 1, "the notary infra declaration reaches the host exactly once");
});
