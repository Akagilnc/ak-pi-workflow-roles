import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AUDITOR_TURN_LIMIT,
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

function auditExtensionContext(
  cwd: string,
  sessionManager: SessionManager,
  faux: ReturnType<typeof fauxProvider>,
): ExtensionContext {
  return {
    cwd,
    model: faux.getModel(),
    modelRegistry: {
      getProvider() { return faux.provider; },
      async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
      async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
    },
    sessionManager,
  } as unknown as ExtensionContext;
}

test("auditor gathers evidence and submits one decision", async () => {
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
      // Zero-projection contract is asserted once at the real judge entry
      // (judge-auditor-dossier.test.ts); this case bites gather + one decision.
      if (turns === 1) {
        // Behavior proof of unrestricted tools (ADR 0064): read is available
        // without a second active-tools / tools allowlist cage.
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
      context: auditExtensionContext(cwd, sessionManager, faux),
    }));
    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("undefined decision candidate settles as typed audit-incomplete", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-undefined-decision-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const faux = fauxProvider({ provider: "undefined-decision-test" });
    const tool = createComplianceDecisionTool("ak_undefined_decision", "Submit.");
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool,
      systemPrompt: "Submit the candidate.",
      roleLabel: "Undefined decision auditor",
      invalidDecisionLabel: "invalid undefined decision",
      runCompletion: async () => fauxAssistantMessage([{
        type: "toolCall",
        id: "undefined-decision-call",
        name: tool.name,
        arguments: undefined as unknown as Record<string, any>,
      }], { stopReason: "toolUse" }),
      context: auditExtensionContext(cwd, sessionManager, faux),
    }));
    assert.equal(decision.status, "audit-incomplete");
    if (decision.status === "audit-incomplete") {
      assert.deepEqual(decision.observation, { kind: "non-object-arguments", type: "undefined" });
      assert.equal(decision.candidate, undefined);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("injected completion preserves same-turn evidence failure identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-evidence-failure-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const faux = fauxProvider({ provider: "evidence-failure-test" });
    const tool = createComplianceDecisionTool("ak_evidence_failure_decision", "Submit.");
    await assert.rejects(
      withRunDir(runDirectory, () => runComplianceAudit({
        tool,
        systemPrompt: "Read and decide.",
        roleLabel: "Evidence failure auditor",
        invalidDecisionLabel: "invalid evidence failure decision",
        runCompletion: async () => fauxAssistantMessage([
          fauxToolCall("read", { path: "missing-evidence.txt" }),
          fauxToolCall(tool.name, { status: "pass" }),
        ], { stopReason: "toolUse" }),
        context: auditExtensionContext(cwd, sessionManager, faux),
      })),
      (error: unknown) => error instanceof Error
        && (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("injected pending completion settles a same-turn evidence and decision batch exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-injected-decision-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    await writeFile(join(cwd, "evidence.txt"), "injected evidence\n");
    const sessionManager = parentWithJudgeSubjects(cwd);
    const faux = fauxProvider({ provider: "injected-decision-test" });
    const baseTool = createComplianceDecisionTool("ak_injected_decision", "Submit.");
    let decisions = 0;
    const tool = {
      ...baseTool,
      async execute(...args: Parameters<typeof baseTool.execute>) {
        decisions += 1;
        return baseTool.execute(...args);
      },
    };
    let completions = 0;
    const decision = await withRunDir(runDirectory, () => runComplianceAudit({
      tool,
      systemPrompt: "Read and decide.",
      roleLabel: "Injected decision auditor",
      invalidDecisionLabel: "invalid injected decision",
      runCompletion: async () => {
        completions += 1;
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "evidence.txt" }),
          fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        ], { stopReason: "pending" });
      },
      context: auditExtensionContext(cwd, sessionManager, faux),
    }));
    assert.equal(decision.status, "pass");
    assert.equal(completions, 1);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const mode of ["provider", "injected"] as const) {
  test(`${mode} completion gives unknown tools native receipts and exhausts at the exact turn limit`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `ak-auditor-${mode}-exhaustion-`));
    const runDirectory = join(cwd, "run");
    await mkdir(runDirectory);
    try {
      const sessionManager = parentWithJudgeSubjects(cwd);
      const faux = fauxProvider({ provider: `${mode}-exhaustion-test` });
      const unknownId = `${mode}-unknown-call`;
      const unknownTool = `ak_${mode}_unknown_decision`;
      let turns = 0;
      const traceTurn = async (context: Context) => {
        turns += 1;
        if (turns > 1) {
          const receipt = [...context.messages].reverse().find((message) =>
            message.role === "toolResult" && message.toolCallId === unknownId);
          assert.equal(receipt?.role, "toolResult");
          if (receipt?.role !== "toolResult") throw new Error("missing native unknown-tool receipt");
          assert.equal(receipt.toolName, unknownTool);
          assert.equal(receipt.isError, true);
        }
        return fauxAssistantMessage([{
          ...fauxToolCall(unknownTool, {}),
          id: unknownId,
        }], { stopReason: "toolUse" });
      };
      if (mode === "provider") {
        faux.setResponses(Array.from({ length: AUDITOR_TURN_LIMIT }, () => traceTurn));
      }

      await assert.rejects(
        withRunDir(runDirectory, () => runComplianceAudit({
          tool: createComplianceDecisionTool(`ak_real_${mode}_decision`, "Submit."),
          systemPrompt: "Decide.",
          roleLabel: `${mode} exhaustion auditor`,
          invalidDecisionLabel: `invalid ${mode} decision`,
          ...(mode === "injected"
            ? { runCompletion: async (_model: unknown, context: Context) => traceTurn(context) }
            : {}),
          context: auditExtensionContext(cwd, sessionManager, faux),
        })),
        (error: unknown) => error instanceof AuditorTurnLimitError
          && error.limit === AUDITOR_TURN_LIMIT
          && error.observedTurns === AUDITOR_TURN_LIMIT
          && error.lastResponse?.stopReason === "toolUse"
          && error.lastResponse.toolNames.includes(unknownTool),
      );
      assert.equal(turns, AUDITOR_TURN_LIMIT);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("provider-stream idle retries at most twice then fails loud as StreamIdleTimeoutError", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-idle-"));
  const runDirectory = join(cwd, "run");
  await mkdir(runDirectory);
  try {
    const sessionManager = parentWithJudgeSubjects(cwd);
    const tool = createComplianceDecisionTool("ak_test_idle_decision", "Submit.");
    let streamAttempts = 0;
    const faux = fauxProvider({ provider: "idle-test" });
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
    faux.provider.stream = idleStream;
    faux.provider.streamSimple = idleStream as typeof faux.provider.streamSimple;

    await assert.rejects(
      withRunDir(runDirectory, () => runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        roleLabel: "Idle auditor",
        invalidDecisionLabel: "invalid idle decision",
        context: auditExtensionContext(cwd, sessionManager, faux),
      })),
      (error: unknown) => isStreamIdleTimeoutError(error)
        && !(error instanceof PackageOwnedToolIdleTimeoutError),
    );
    assert.equal(streamAttempts, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("package-owned tool idle identity is not StreamIdleTimeoutError", () => {
  const packageIdle = new PackageOwnedToolIdleTimeoutError();
  assert.equal(isStreamIdleTimeoutError(packageIdle), false);
  assert.equal(packageIdle.name, "PackageOwnedToolIdleTimeoutError");
  assert.notEqual(packageIdle.name, "StreamIdleTimeoutError");
});
