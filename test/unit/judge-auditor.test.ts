import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AssistantMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiJudgeAuditor } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";

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

function seedSubjects(sessionManager: SessionManager): void {
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "v1",
      name: JUDGE_OUTPUT_TOOL_NAME,
      arguments: { judgeStatus: "converged" },
    }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
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
  const sessionManager = SessionManager.inMemory();
  seedSubjects(sessionManager);
  return {
    model,
    sessionManager,
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

test("Pi judge auditor preserves authentication failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-judge-auth-"));
  const runDirectory = join(root, "run");
  await mkdir(runDirectory);
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  try {
    const context = auditContext(undefined, new Error("login expired"));
    const auditor = createPiJudgeAuditor(async () =>
      auditResponse({ status: "pass", violations: [], conflicts: [], decisionGate: null }),
    );

    await assert.rejects(
      auditor({ context }),
      /authentication failed: login expired/,
    );
  } finally {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
