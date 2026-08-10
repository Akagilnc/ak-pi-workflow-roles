import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AuditorTurnLimitError,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
} from "../../src/evidence-child-executor.ts";
import { createComplianceDecisionTool, runComplianceAudit } from "../../src/compliance-transport.ts";
import {
  PackageOwnedToolIdleTimeoutError,
} from "../../src/package-owned-tool-idle.ts";
import {
  StreamIdleTimeoutError,
  isStreamIdleTimeoutError,
} from "../../src/stream-idle-guard.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/dossier-resolution.ts";

function withRunDir<T>(runDirectory: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDirectory;
  return run().finally(() => {
    if (previous === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previous;
  });
}

function parentWithJudgeSubjects(cwd: string): SessionManager {
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT: adjudicate",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "verdict-1",
      name: JUDGE_OUTPUT_TOOL_NAME,
      arguments: { judgeStatus: "converged" },
    }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  return sessionManager;
}

test("auditor source has no tools allowlist and no second active-tools cage", () => {
  // Class 3 retires this source-text gate in favor of behavior assertions.
  const helper = readFileSync(new URL("../../src/evidence-child-executor.ts", import.meta.url), "utf8");
  assert.equal(/\btools:\s*\[/.test(helper), false, "must not hardcode a tools allowlist");
  assert.equal(/setActiveTools\s*\(/.test(helper), false, "must not install a second active-tools cage");
  assert.equal(/bashCommands/.test(helper), false, "must not cage bashCommands");
});

test("auditor gathers evidence without projected materials and submits one decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-zero-projection-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    await writeFile(join(cwd, "evidence.txt"), "court evidence: accepted\n");
    const sessionManager = parentWithJudgeSubjects(cwd);
    const baseTool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    let decisions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        decisions += 1;
        return baseTool.execute(...args);
      },
    };
    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      // Zero projection: user message must not embed soul/transcript/verdict blocks.
      const userText = context.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content))
        .join("\n");
      assert.equal(/judge_soul|adjudication_record|proposed_verdict/.test(userText), false);
      if (turns === 1) {
        return fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })], { stopReason: "toolUse" });
      }
      assert.ok(context.messages.some((message) =>
        message.role === "toolResult" && JSON.stringify(message.content).includes("court evidence: accepted")));
      return fauxAssistantMessage(
        [fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })],
        { stopReason: "toolUse" },
      );
    };
    const faux = fauxProvider({ provider: "audit-test" });
    faux.setResponses([complete, complete]);
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool,
      systemPrompt: "Read evidence, then submit exactly one decision.",
      roleLabel: "Test auditor",
      invalidDecisionLabel: "invalid test decision",
      context: {
        cwd,
        model: faux.getModel(),
        modelRegistry: {
          getProvider() { return faux.provider; },
          async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
        },
        sessionManager,
      } as unknown as ExtensionContext,
    }));
    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider-stream idle retries at most twice then fails loud as StreamIdleTimeoutError", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-idle-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const tool = createComplianceDecisionTool("ak_test_idle_decision", "Submit.");
    let streamAttempts = 0;
    const faux = fauxProvider({ provider: "idle-test" });
    // Replace stream with an always-idle failure that surfaces StreamIdleTimeoutError.
    const idleStream = (() => {
      streamAttempts += 1;
      const error = new StreamIdleTimeoutError(1);
      return {
        async *[Symbol.asyncIterator]() {
          throw error;
        },
        result: async () => {
          throw error;
        },
      } as unknown as ReturnType<typeof faux.provider.stream>;
    }) as typeof faux.provider.stream;
    // ModelRuntime drives streamSimple; keep both faces on the idle identity.
    faux.provider.stream = idleStream;
    faux.provider.streamSimple = idleStream as typeof faux.provider.streamSimple;

    await assert.rejects(
      withRunDir(runDirectory, () => runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        roleLabel: "Idle auditor",
        invalidDecisionLabel: "invalid idle decision",
        context: {
          cwd,
          model: faux.getModel(),
          modelRegistry: {
            getProvider() { return faux.provider; },
            async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
            async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "secret" }; },
          },
          sessionManager,
        } as unknown as ExtensionContext,
      })),
      (error: unknown) => isStreamIdleTimeoutError(error)
        && !(error instanceof PackageOwnedToolIdleTimeoutError),
    );
    // initial attempt + DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES retries
    assert.equal(streamAttempts, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("AuditorTurnLimitError remains the finite provider-turn boundary", () => {
  const error = new AuditorTurnLimitError(32);
  assert.equal(error.name, "AuditorTurnLimitError");
  assert.equal(error.limit, 32);
  assert.match(error.message, /32/);
});

test("package-owned tool idle identity is not StreamIdleTimeoutError", () => {
  const packageIdle = new PackageOwnedToolIdleTimeoutError();
  assert.equal(isStreamIdleTimeoutError(packageIdle), false);
  assert.equal(packageIdle.name, "PackageOwnedToolIdleTimeoutError");
  assert.notEqual(packageIdle.name, "StreamIdleTimeoutError");
});
