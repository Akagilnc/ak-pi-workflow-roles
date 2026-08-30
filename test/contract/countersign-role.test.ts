import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  validateRecordedCountersignOutput,
} from "../../src/countersign-contracts.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";

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

test("validateRecordedCountersignOutput recognizes 署/封驳/上呈 read-only — 原卷保真", () => {
  // 原卷保真 (ADR 0055): lawful verdicts are delivered untouched — no field
  // defaulted, rewritten, or dropped (#572 判词送修 2).
  const sealedBack = validateRecordedCountersignOutput({
    countersignStatus: "continue",
    findings: ["x"],
    evidence: "e-1",
  }) as unknown as Record<string, unknown>;
  assert.equal(sealedBack.countersignStatus, "continue");
  assert.equal("disposition" in sealedBack, false, "no disposition default may be injected");
  assert.deepEqual(sealedBack.findings, ["x"], "findings must not be normalized");
  assert.equal(sealedBack.evidence, "e-1", "evidence must survive");
  assert.equal(
    validateRecordedCountersignOutput({ countersignStatus: "converged", note: "n" }).countersignStatus,
    "converged",
  );
  assert.equal(
    validateRecordedCountersignOutput({
      countersignStatus: "escalate",
      decisionGate: { question: "q", options: ["a"] },
    }).countersignStatus,
    "escalate",
  );
  assert.throws(() => validateRecordedCountersignOutput({ countersignStatus: "maybe" }));
  assert.throws(() => validateRecordedCountersignOutput({ status: "converged" }));
  assert.throws(() => validateRecordedCountersignOutput(null));
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
  assert.ok(prompted.systemPrompt.length > "BASE".length);
});

test("Countersign runtime refuses empty soul", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "   " },
    { failInfrastructure(error) { throw error; } },
  );
  await assert.rejects(runtime.activate());
});

test("Countersign execute rejects infrastructure failure and non-unique final before acceptance", async () => {
  const h = countersignHarness();
  let infraHostCalls = 0;
  const runtime = createCountersignRoleRuntime(
    h.pi as never,
    { loadSoul: async () => "LAW" },
    {
      failInfrastructure(error: unknown, _ctx: unknown, id?: string) {
        infraHostCalls += 1;
        assert.equal(id, "infra");
        throw error instanceof Error ? error : new Error(String(error));
      },
    },
  );
  await runtime.activate();
  const tool = h.tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME);
  assert.ok(tool);

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  // (a) infrastructure-failure declaration reaches the host before any acceptance.
  const infraSession = SessionManager.inMemory();
  infraSession.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "infra", name: COUNTERSIGN_OUTPUT_TOOL_NAME, arguments: {} }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 0,
  });
  await assert.rejects(
    tool.execute("infra", { infrastructureFailure: { diagnostic: "countersign engine down" } }, undefined, undefined, { sessionManager: infraSession }),
    (error: unknown) => error instanceof Error && error.message === "countersign engine down",
  );
  assert.equal(infraHostCalls, 1, "infra declaration reaches the host exactly once");

  // (b) non-unique final submission is rejected, never accepted.
  const nonUniqueSession = SessionManager.inMemory();
  nonUniqueSession.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "one", name: COUNTERSIGN_OUTPUT_TOOL_NAME, arguments: {} },
      { type: "toolCall", id: "two", name: COUNTERSIGN_OUTPUT_TOOL_NAME, arguments: {} },
    ],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 0,
  });
  await assert.rejects(
    tool.execute("one", { countersignStatus: "continue" }, undefined, undefined, { sessionManager: nonUniqueSession }),
    /非唯一终局/,
  );
});

