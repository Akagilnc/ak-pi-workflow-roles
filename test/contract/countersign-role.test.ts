import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  projectLawfulCountersignOutput,
  retainCountersignSubmission,
} from "../../src/countersign-contracts.ts";
import { createCountersignRoleRuntime } from "../../src/countersign-role.ts";

/** Shared mock-Pi harness for the Countersign runtime. */
function countersignHarness() {
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const pi = {
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) { if (event === "before_agent_start") beforeStart = handler; },
    getAllTools() { return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }] },
  };
  return { tools, pi, beforeStart: () => beforeStart };
}

test("projectLawfulCountersignOutput projects 署/封驳/上呈; non-verdict retained as-is", () => {
  assert.equal(projectLawfulCountersignOutput({ countersignStatus: "converged", findings: [] })?.countersignStatus, "converged");
  const sealedBack = projectLawfulCountersignOutput({ countersignStatus: "continue", findings: ["x"] });
  assert.equal(sealedBack?.countersignStatus, "continue");
  // 封驳 defaults to rewrite disposition — 退回重议, not run failure.
  assert.equal((sealedBack as { disposition?: string }).disposition, "rewrite");
  assert.equal(projectLawfulCountersignOutput({ countersignStatus: "escalate", findings: [] })?.countersignStatus, "escalate");
  // ADR 0055 / 第 0 条: no shape admission throw — non-verdict stays undefined projection.
  assert.equal(projectLawfulCountersignOutput({ countersignStatus: "maybe", note: "not a verdict" }), undefined);
  assert.equal(projectLawfulCountersignOutput({ status: "converged" }), undefined);
  assert.equal(projectLawfulCountersignOutput(null), undefined);
  const raw = { countersignStatus: "maybe", note: "not an explicit verdict" };
  assert.deepEqual(retainCountersignSubmission(raw), raw);
});

test("Countersign runtime registers output tool and injects soul without ticket body preload", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "COUNTERSIGN LAW" },
    { failInfrastructure(error) { throw error; } },
  );
  await runtime.activate();
  assert.ok(h.tools.has(COUNTERSIGN_OUTPUT_TOOL_NAME));
  assert.ok(h.beforeStart());

  const prompted = h.beforeStart()!({ systemPrompt: "BASE" }) as {
    systemPrompt: string;
  };
  // Soul-only injection: no ticket body preload key (materials flow via transport prompt).
  assert.ok(prompted.systemPrompt.includes("COUNTERSIGN LAW"));
  assert.ok(prompted.systemPrompt.includes("<countersign_soul>"));
  assert.equal(prompted.systemPrompt.includes('"material"'), false);
});

test("Countersign runtime refuses empty soul", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "   " },
    { failInfrastructure(error) { throw error; } },
  );
  await assert.rejects(runtime.activate(), /Countersign soul is empty/);
});

test("Countersign output enforces the singleton terminating submission", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "LAW" },
    { failInfrastructure(error) { throw error; } },
  );
  await runtime.activate();
  const tool = h.tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "thinking out loud" }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  });
  const parameters = { countersignStatus: "converged", findings: [] };
  await assert.rejects(
    tool.execute("call-1", parameters, undefined, undefined, { sessionManager }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "给事中回执非唯一终局工具调用");
      return true;
    },
  );
});
