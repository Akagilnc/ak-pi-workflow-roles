import assert from "node:assert/strict";
import test from "node:test";

import type {
  AssistantMessage,
  Context,
  ProviderStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor } from "../../src/judge-auditor.ts";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

function auditResponse(
  ...decisions: Array<Record<string, unknown>>
): AssistantMessage {
  return {
    role: "assistant",
    content: decisions.map((arguments_, index) => ({
      type: "toolCall" as const,
      id: `audit-${index}`,
      name: "ak_soul_audit_decision",
      arguments: arguments_,
    })),
    api: "openai-responses",
    provider: "openai",
    model: "auditor",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function auditContext(
  resolution:
    | {
        auth: {
          apiKey?: string;
          headers?: Record<string, string>;
          baseUrl?: string;
        };
        env?: Record<string, string>;
      }
    | undefined = {
    auth: { apiKey: "secret", headers: {} },
    env: {},
  },
  authError?: Error,
) {
  const model = { provider: "test", id: "auditor" };
  return {
    model,
    sessionManager: SessionManager.inMemory(),
    modelRegistry: {
      async getProviderAuth(received: unknown) {
        assert.equal(received, model.provider);
        if (authError) throw authError;
        return resolution;
      },
      async getApiKeyAndHeaders(received: unknown) {
        assert.equal(received, model);
        if (resolution === undefined) {
          return { ok: false as const, error: "provider is not configured" };
        }
        return {
          ok: true as const,
          ...(resolution.auth.apiKey === undefined
            ? {}
            : { apiKey: resolution.auth.apiKey }),
          ...(resolution.auth.headers === undefined
            ? {}
            : { headers: resolution.auth.headers }),
          ...(resolution.env === undefined ? {} : { env: resolution.env }),
        };
      },
    },
  } as unknown as ExtensionContext;
}

const auditInput = {
  soul: "THE JUDGE LAW",
  transcript: "THE ADJUDICATION RECORD",
  verdict: { judgeStatus: "converged" as const },
};

test("Pi judge auditor submits the record and accepts an exact pass decision", async () => {
  const calls: Array<{ context: Context; options: ProviderStreamOptions }> = [];
  const auditor = createPiJudgeAuditor(async (_model, context, options) => {
    calls.push({ context, options });
    return auditResponse({ status: "pass", violations: [], conflicts: [], decisionGate: null });
  });

  const result = await auditor(auditInput, { context: auditContext() });

  assert.deepEqual(result, { status: "pass", usage });
  const request = JSON.stringify(calls[0]?.context);
  assert.match(request, /THE JUDGE LAW/);
  assert.match(request, /THE ADJUDICATION RECORD/);
  assert.match(request, /converged/);
});

test("Pi judge auditor accepts an exact revise decision", async () => {
  const auditor = createPiJudgeAuditor(async () =>
    auditResponse({ status: "revise", violations: ["rule 1", "rule 2"], conflicts: [], decisionGate: null }),
  );

  assert.deepEqual(
    await auditor(auditInput, { context: auditContext() }),
    { status: "revise", violations: ["rule 1", "rule 2"], usage },
  );
});

test("Pi judge auditor accepts formerly shape-rejected decisions without aborting (#177 S4)", async (t) => {
  // ADR 0055/0056/0057: runtime no longer shape-rejects compliance decisions.
  const cases: Array<[string, Record<string, unknown>, "pass" | "revise"]> = [
    ["pass with violations", { status: "pass", violations: ["contradiction"] }, "pass"],
    ["empty revise", { status: "revise", violations: [] }, "revise"],
    ["blank violation", { status: "revise", violations: ["  "] }, "revise"],
    ["mixed violation values", { status: "revise", violations: ["real", 4] }, "revise"],
    ["non-array violations", { status: "revise", violations: "rule 1" }, "revise"],
    ["unknown key", { status: "pass", violations: [], explanation: "extra" }, "pass"],
    ["missing violations", { status: "pass" }, "pass"],
    ["unknown status", { status: "maybe", violations: [] }, "pass"],
  ];

  for (const [name, decision, expected] of cases) {
    await t.test(name, async () => {
      const auditor = createPiJudgeAuditor(async () => auditResponse(decision));
      const result = await auditor(auditInput, { context: auditContext() });
      assert.equal(result.status, expected);
    });
  }
});

test("Pi judge auditor requires exactly one decision call", async () => {
  const decisionWithExtraCall = auditResponse({ status: "pass", violations: [], conflicts: [], decisionGate: null });
  decisionWithExtraCall.content.push({
    type: "toolCall",
    id: "other-1",
    name: "other_tool",
    arguments: {},
  });
  for (const response of [
    auditResponse(),
    auditResponse(
      { status: "pass", violations: [], conflicts: [], decisionGate: null },
      { status: "revise", violations: ["contradiction"], conflicts: [], decisionGate: null },
    ),
    decisionWithExtraCall,
  ]) {
    const auditor = createPiJudgeAuditor(async () => response);
    await assert.rejects(
      auditor(auditInput, { context: auditContext() }),
      /expected exactly one decision tool call/,
    );
  }
});

test("Pi judge auditor supports successful keyless provider authentication", async () => {
  let seenOptions: ProviderStreamOptions | undefined;
  const auditor = createPiJudgeAuditor(async (_model, _context, options) => {
    seenOptions = options;
    return auditResponse({ status: "pass", violations: [], conflicts: [], decisionGate: null });
  });

  assert.equal(
    (await auditor(auditInput, {
      context: auditContext({ auth: { headers: { "x-test": "yes" } } }),
    })).status,
    "pass",
  );
  assert.equal(Object.hasOwn(seenOptions ?? {}, "apiKey"), false);
  assert.deepEqual(seenOptions?.headers, { "x-test": "yes" });
});

test("Pi judge auditor preserves authentication failures", async () => {
  const context = auditContext(undefined, new Error("login expired"));
  const auditor = createPiJudgeAuditor(async () =>
    auditResponse({ status: "pass", violations: [], conflicts: [], decisionGate: null }),
  );

  await assert.rejects(
    auditor(auditInput, { context }),
    /authentication failed: login expired/,
  );
});
