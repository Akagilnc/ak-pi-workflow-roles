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
