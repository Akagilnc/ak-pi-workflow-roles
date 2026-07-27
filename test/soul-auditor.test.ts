import assert from "node:assert/strict";
import test from "node:test";

import type {
  AssistantMessage,
  Context,
  ProviderStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiSoulAuditor } from "../src/soul-auditor.ts";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

function auditResponse(arguments_: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "audit-1",
        name: "ak_soul_audit_decision",
        arguments: arguments_,
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "auditor",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function auditContext() {
  const model = { provider: "test", id: "auditor" };
  return {
    model,
    modelRegistry: {
      async getApiKeyAndHeaders(received: unknown) {
        assert.equal(received, model);
        return { ok: true, apiKey: "secret", headers: {}, env: {} };
      },
    },
  };
}

test("Pi soul auditor submits the soul, transcript, and verdict and accepts its typed pass", async () => {
  const calls: Array<{ context: Context; options: ProviderStreamOptions }> = [];
  const auditor = createPiSoulAuditor(async (_model, context, options) => {
    calls.push({ context, options });
    return auditResponse({ status: "pass", violations: [] });
  });

  const result = await auditor(
    {
      soul: "THE JUDGE LAW",
      transcript: "THE ADJUDICATION RECORD",
      verdict: { judgeStatus: "converged" },
    },
    { context: auditContext() as ExtensionContext },
  );

  assert.equal(result.status, "pass");
  assert.equal(result.usage, usage);
  const request = JSON.stringify(calls[0]?.context);
  assert.match(request, /THE JUDGE LAW/);
  assert.match(request, /THE ADJUDICATION RECORD/);
  assert.match(request, /converged/);
});

test("Pi soul auditor rejects malformed or empty revise decisions", async () => {
  const auditor = createPiSoulAuditor(async () =>
    auditResponse({ status: "revise", violations: [] }),
  );

  await assert.rejects(
    auditor(
      {
        soul: "LAW",
        transcript: "RECORD",
        verdict: { judgeStatus: "converged" },
      },
      { context: auditContext() as ExtensionContext },
    ),
    /invalid soul audit decision/,
  );
});
