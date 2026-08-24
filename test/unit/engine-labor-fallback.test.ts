/**
 * #380 — sole seat-fallback declaration mechanics (latch, projection, resume restore).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
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
  seatFallbackBaseStatus,
  withEngineLaborFallbackField,
} from "../../src/engine-labor-fallback.ts";
import { createJudgeRoleRuntime, JUDGE_OUTPUT_TOOL_NAME } from "../../src/judge-role.ts";
import { NOTARY_OUTPUT_TOOL, GATEKEEPER_OUTPUT_TOOL } from "../../src/gatekeeper-role.ts";
import { selectNavigatorCandidate } from "../../src/navigator-attendance.ts";
import { NAVIGATOR_INVOCATION_ENTRY } from "../../src/navigator-invocation-identity.ts";
import {
  AcceptedDetailsContractError,
  validateAcceptedDetails,
} from "../../src/package-contracts/terminating-tools.ts";
import { extractJudgeRoleOutcome } from "../../src/public-cli/settlement.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";

function withPassingGatekeeper(context: ExtensionContext): ExtensionContext {
  const faux = fauxProvider({ provider: "passing-gatekeeper", api: "passing-gatekeeper" });
  const model = faux.getModel();
  const responses = [
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "notary" })),
    fauxAssistantMessage(fauxToolCall(NOTARY_OUTPUT_TOOL, { status: "pass", findings: [] })),
  ];
  const provider = {
    ...faux.provider,
    stream() {
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected Gatekeeper provider request");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end(next));
      return stream;
    },
    streamSimple() { return this.stream(); },
  };
  return Object.assign(context, {
    cwd: process.cwd(),
    model,
    modelRegistry: {
      getProvider(name: string) { return name === model.provider ? provider : undefined; },
      async getProviderAuth() { return { auth: {} }; },
      async getApiKeyAndHeaders() { return { ok: true }; },
    },
    thinkingLevel: "off",
  });
}

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
  // Seat-fallback taints the typed status discriminator (not a clean continue).
  assert.equal(overlaid.judgeStatus, "continue-by-fallback");
});

test("engineLaborFallback taints clean typed status — judgeStatus must not stay converged", () => {
  const latch = createEngineLaborFallbackLatch();
  const mechanical = recordEngineLaborFallback(latch, {
    engine: "kimi",
    failure: "engine exit 1",
  });
  const receipt = withEngineLaborFallbackField(
    { judgeStatus: "converged" as const, note: "seat wrote this" },
    mechanical,
  ) as {
    judgeStatus: string;
    note: string;
    engineLaborFallback?: { engine: string; failure: string; laborBy: "seat" };
  };
  assert.ok(
    receipt.engineLaborFallback,
    "mechanical fallback field must be declared",
  );
  assert.notEqual(
    receipt.judgeStatus,
    "converged",
    "owner: fallback must not leave clean converged on the status line",
  );
  assert.equal(receipt.judgeStatus, "converged-by-fallback");
  assert.match(String(receipt.judgeStatus), /-by-fallback$/);
});

test("engineLaborFallback taints clean worker status — status must not stay completed", () => {
  const latch = createEngineLaborFallbackLatch();
  const mechanical = recordEngineLaborFallback(latch, {
    engine: "codex",
    failure: "trim-empty stdout",
  });
  const receipt = withEngineLaborFallbackField(
    { status: "completed" as const, report: "seat labor" },
    mechanical,
  );
  assert.notEqual(receipt.status, "completed");
  assert.equal(receipt.status, "completed-by-fallback");
});

test("no fallback leaves clean status untouched", () => {
  const clean = withEngineLaborFallbackField(
    { judgeStatus: "converged" as const },
    undefined,
  );
  assert.equal(clean.judgeStatus, "converged");
  assert.equal(
    Object.prototype.hasOwnProperty.call(clean, "engineLaborFallback"),
    false,
  );
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

test("settlement accepts tainted judgeStatus and keeps it on the status line", () => {
  const latch = createEngineLaborFallbackLatch();
  const mechanical = recordEngineLaborFallback(latch, {
    engine: "kimi",
    failure: "exit 1",
  });
  const details = withEngineLaborFallbackField(
    { judgeStatus: "converged" as const, note: "seat" },
    mechanical,
  );
  assert.equal(details.judgeStatus, "converged-by-fallback");

  const entries = [
    {
      type: "custom",
      customType: NAVIGATOR_INVOCATION_ENTRY,
      data: {
        invocationId: "019f8c2a-fbfb-7fbf-8fbf-fbfbfbfbfbfb",
        role: "judge",
        phase: null,
        subjectKey: "/repo/.ak/work",
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details,
      },
    },
  ];
  const outcome = extractJudgeRoleOutcome(entries as never);
  assert.ok(outcome, "tainted status must remain a lawful accepted outcome");
  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.status, "converged-by-fallback");
  assert.equal(outcome.decisiveFacts.judgeStatus, "converged-by-fallback");
  assert.ok(
    (outcome.decisiveFacts as { engineLaborFallback?: unknown }).engineLaborFallback,
  );
});

test("navigator treats escalate-by-fallback as human_decision and matches clean status routes", () => {
  const fallback = {
    engine: "kimi",
    failure: "exit 1",
    laborBy: "seat" as const,
  };
  const settlement = publicNavigatorSettlement("judge", null, {
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    isError: false,
    details: {
      judgeStatus: "escalate-by-fallback",
      engineLaborFallback: fallback,
    },
  });
  assert.deepEqual(settlement, {
    kind: "human_decision",
    role: "judge",
    phase: null,
    status: "escalate-by-fallback",
  });

  const accepted = publicNavigatorSettlement("judge", null, {
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    isError: false,
    details: {
      judgeStatus: "converged-by-fallback",
      engineLaborFallback: fallback,
    },
  });
  assert.deepEqual(accepted, {
    kind: "accepted",
    role: "judge",
    phase: null,
    status: "converged-by-fallback",
  });

  const convergedRoute = {
    id: "converged-route",
    next: { role: "coder" as const, phase: "apply" as const },
    reason: "after clean or seat-fallback converge",
    matches: {
      role: "judge",
      phase: null,
      kind: "accepted" as const,
      statuses: ["converged"],
    },
  };
  const selection = selectNavigatorCandidate([convergedRoute], accepted!);
  assert.equal(selection?.candidate.id, "converged-route");
  assert.equal(seatFallbackBaseStatus("converged-by-fallback"), "converged");
});

test("tainted status without engineLaborFallback is not a lawful terminal", () => {
  assert.throws(
    () =>
      validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, {
        judgeStatus: "converged-by-fallback",
        note: "forged taint",
      }),
    (error: unknown) =>
      error instanceof AcceptedDetailsContractError &&
      /no recognized execution discriminator/.test(error.message),
  );

  // Valid latch-shaped evidence pairs with the suffix.
  const accepted = validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, {
    judgeStatus: "converged-by-fallback",
    note: "seat",
    engineLaborFallback: {
      engine: "kimi",
      failure: "exit 1",
      laborBy: "seat",
    },
  });
  assert.equal(
    (accepted as { judgeStatus: string }).judgeStatus,
    "converged-by-fallback",
  );

  // Settlement / navigator refuse the same forged face.
  const entries = [
    {
      type: "custom",
      customType: NAVIGATOR_INVOCATION_ENTRY,
      data: {
        invocationId: "019f8c2a-fbfb-7fbf-8fbf-fbfbfbfbfbfb",
        role: "judge",
        phase: null,
        subjectKey: "/repo/.ak/work",
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        isError: false,
        details: { judgeStatus: "converged-by-fallback", note: "forged" },
      },
    },
  ];
  assert.equal(
    extractJudgeRoleOutcome(entries as never),
    undefined,
    "settlement must not accept tainted status without engineLaborFallback",
  );
  assert.equal(
    publicNavigatorSettlement("judge", null, {
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      isError: false,
      details: { judgeStatus: "escalate-by-fallback" },
    }),
    undefined,
    "navigator must not project tainted status without engineLaborFallback",
  );
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
    const ctx = withPassingGatekeeper({ sessionManager, abort() {} } as unknown as ExtensionContext);

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
