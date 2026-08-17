/**
 * #380 — sole seat-fallback declaration mechanics (latch, projection, resume restore).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { AUDIT_ESCALATION_KIND } from "../../src/audit-escalation.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import {
  clearActivationEngineLaborFallbackLatch,
  createEngineLaborFallbackLatch,
  installActivationEngineLaborFallbackLatch,
  readEngineLaborFallbackField,
  recordEngineLaborFallback,
  restoreEngineLaborFallbackFromSessionEntries,
  withEngineLaborFallbackField,
} from "../../src/engine-labor-fallback.ts";
import { createJudgeRoleRuntime, JUDGE_OUTPUT_TOOL_NAME } from "../../src/judge-role.ts";

test("recordEngineLaborFallback is first-wins for both retain and return", () => {
  const latch = createEngineLaborFallbackLatch();
  const first = recordEngineLaborFallback(latch, {
    engine: "kimi",
    failure: "first-fail",
  });
  const second = recordEngineLaborFallback(latch, {
    engine: "other",
    failure: "second-fail",
  });
  assert.equal(second, first);
  assert.equal(second.engineLaborFallback.engine, "kimi");
  assert.equal(second.engineLaborFallback.failure, "first-fail");
  assert.equal(readEngineLaborFallbackField(latch), first);
});

test("withEngineLaborFallbackField strips forged key when latch empty; overlays when present", () => {
  const forged = {
    judgeStatus: "continue" as const,
    engineLaborFallback: {
      engine: "forged",
      failure: "model-lie",
      laborBy: "seat" as const,
    },
    note: "keep-me",
  };
  const stripped = withEngineLaborFallbackField(forged, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(stripped, "engineLaborFallback"),
    false,
    "forged reserved key must be removed without mechanical latch",
  );
  assert.equal(stripped.note, "keep-me");
  assert.equal(stripped.judgeStatus, "continue");

  const latch = createEngineLaborFallbackLatch();
  const mechanical = recordEngineLaborFallback(latch, {
    engine: "kimi",
    failure: "real",
  });
  const overlaid = withEngineLaborFallbackField(forged, mechanical);
  assert.deepEqual(overlaid.engineLaborFallback, mechanical.engineLaborFallback);
  assert.equal(overlaid.note, "keep-me");
});

test("restoreEngineLaborFallbackFromSessionEntries replays detour tool results first-wins", () => {
  const latch = createEngineLaborFallbackLatch();
  const entries = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: ENGINE_DETOUR_TOOL_NAME,
        details: {
          tool: ENGINE_DETOUR_TOOL_NAME,
          detourFailed: true,
          engineLaborFallback: {
            engine: "kimi",
            failure: "first-session-fail",
            laborBy: "seat",
          },
        },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: ENGINE_DETOUR_TOOL_NAME,
        details: {
          engineLaborFallback: {
            engine: "other",
            failure: "later-fail",
            laborBy: "seat",
          },
        },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "ak_judge_output",
        details: {
          engineLaborFallback: {
            engine: "ignored",
            failure: "not-detour",
            laborBy: "seat",
          },
        },
      },
    },
  ];
  restoreEngineLaborFallbackFromSessionEntries(
    latch,
    entries,
    ENGINE_DETOUR_TOOL_NAME,
  );
  const field = readEngineLaborFallbackField(latch);
  assert.ok(field);
  assert.equal(field.engineLaborFallback.engine, "kimi");
  assert.equal(field.engineLaborFallback.failure, "first-session-fail");
  assert.equal(field.engineLaborFallback.laborBy, "seat");
});

test("judge escalate deliveredOutput projects mechanical engineLaborFallback", async () => {
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const pi = {
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
      tools.set(tool.name, tool);
    },
    on() {},
  } as unknown as ExtensionAPI;

  const latch = createEngineLaborFallbackLatch();
  const mechanical = recordEngineLaborFallback(latch, {
    engine: "kimi",
    failure: "engine exit 1",
  });
  installActivationEngineLaborFallbackLatch(latch);
  try {
    const runtime = createJudgeRoleRuntime(
      pi,
      {
        loadSoul: async () => "JUDGE LAW",
        auditSoulCompliance: async () => ({
          status: "escalate",
          conflicts: ["need owner"],
          decisionGate: { question: "Q?", options: ["A"] },
        }),
      },
      { failInfrastructure(error) { throw error; } },
    );
    await runtime.activate();
    const tool = tools.get(JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(tool);

    const sessionManager = SessionManager.inMemory();
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "j1",
          name: JUDGE_OUTPUT_TOOL_NAME,
          arguments: {},
        },
      ],
      api: "openai-responses",
      provider: "test",
      model: "judge",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    } satisfies AssistantMessage;
    sessionManager.appendMessage(message);
    const ctx = { sessionManager, abort() {} } as unknown as ExtensionContext;

    const result = await tool.execute(
      "j1",
      {
        judgeStatus: "escalate",
        note: "owner gate",
        // Model-forged key must be overwritten by mechanical latch on escalate face.
        engineLaborFallback: {
          engine: "forged",
          failure: "lie",
          laborBy: "seat",
        },
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
    assert.deepEqual(
      result.details.engineLaborFallback,
      mechanical.engineLaborFallback,
    );
    assert.equal(result.details.note, "owner gate");
  } finally {
    clearActivationEngineLaborFallbackLatch();
  }
});
