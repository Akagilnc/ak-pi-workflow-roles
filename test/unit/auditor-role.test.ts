import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUDITOR_TURN_LIMIT, AuditorTurnLimitError, runAuditorRole } from "../../src/auditor-role.ts";
import { createComplianceDecisionTool, runComplianceAudit } from "../../src/compliance-transport.ts";

test("constant unknown tools receive error results and exhaust at a finite typed boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-unknown-"));
  try {
    const faux = fauxProvider({ provider: "audit-unknown" });
    const seen: Context[] = [];
    faux.setResponses(Array.from({ length: AUDITOR_TURN_LIMIT }, () => (context: Context) => {
      seen.push(context);
      return fauxAssistantMessage([fauxToolCall("ak_other_decision", { status: "pass" })], { stopReason: "toolUse" });
    }));
    const model = faux.getModel();
    const context = {
      cwd,
      model,
      modelRegistry: {
        getProvider() { return faux.provider; },
        async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
        async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
      },
      sessionManager: SessionManager.inMemory(cwd),
    } as unknown as ExtensionContext;
    const tool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    await assert.rejects(
      runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool, roleLabel: "Test auditor", context }),
      (error: unknown) => {
        assert.ok(error instanceof AuditorTurnLimitError);
        assert.equal(error.limit, AUDITOR_TURN_LIMIT);
        assert.equal(error.observedTurns, AUDITOR_TURN_LIMIT);
        assert.deepEqual(error.lastResponse?.toolNames, ["ak_other_decision"]);
        return true;
      },
    );
    assert.equal(seen.length, AUDITOR_TURN_LIMIT);
    for (const nextTurn of seen.slice(1)) {
      const result = nextTurn.messages.find((message) => message.role === "toolResult" && message.toolName === "ak_other_decision");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, true);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider and decision-tool failures on the limit turn retain their original identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-boundary-cause-"));
  try {
    const faux = fauxProvider({ provider: "audit-boundary-cause" });
    const model = faux.getModel();
    const context = {
      cwd,
      model,
      modelRegistry: {
        getProvider() { return faux.provider; },
        async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
        async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
      },
      sessionManager: SessionManager.inMemory(cwd),
    } as unknown as ExtensionContext;
    const unknown = () => fauxAssistantMessage([fauxToolCall("ak_other_decision", {})], { stopReason: "toolUse" });

    const providerFailure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed at boundary" });
    faux.setResponses([...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown), providerFailure]);
    await assert.rejects(
      runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: createComplianceDecisionTool("ak_boundary_provider", "Submit."), roleLabel: "Test auditor", context }),
      (error: unknown) => {
        assert.ok(!(error instanceof AuditorTurnLimitError));
        assert.equal((error as { role?: unknown }).role, "assistant");
        assert.equal((error as { stopReason?: unknown }).stopReason, "error");
        assert.equal((error as { errorMessage?: unknown }).errorMessage, "provider failed at boundary");
        return true;
      },
    );

    const toolFailure = new Error("decision execution failed at boundary");
    const baseTool = createComplianceDecisionTool("ak_boundary_tool", "Submit.");
    const failingTool = { ...baseTool, async execute() { throw toolFailure; } };
    faux.setResponses([
      ...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown),
      fauxAssistantMessage([fauxToolCall(failingTool.name, { status: "pass" })], { stopReason: "toolUse" }),
    ]);
    await assert.rejects(
      runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: failingTool, roleLabel: "Test auditor", context }),
      (error: unknown) => error === toolFailure,
    );

    faux.setResponses([
      ...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown),
      fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
    ]);
    await assert.rejects(
      runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: baseTool, roleLabel: "Test auditor", context }),
      (error: unknown) => {
        assert.ok(!(error instanceof AuditorTurnLimitError));
        assert.equal((error as { role?: unknown }).role, "toolResult");
        assert.equal((error as { toolName?: unknown }).toolName, "read");
        assert.equal((error as { isError?: unknown }).isError, true);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("evidence and decision calls in the same assistant turn succeed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-same-turn-"));
  try {
    await writeFile(join(cwd, "evidence.txt"), "same-turn evidence\n");
    const faux = fauxProvider({ provider: "audit-same-turn" });
    const tool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "evidence.txt" }),
        fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ], { stopReason: "toolUse" }),
    ]);
    const result = await runAuditorRole({
      systemPrompt: "Inspect and decide.",
      serializedInput: "Inspect evidence.txt and decide.",
      tool,
      roleLabel: "Test auditor",
      context: {
        cwd,
        model: faux.getModel(),
        modelRegistry: {
          getProvider() { return faux.provider; },
          async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
        },
        sessionManager: SessionManager.inMemory(cwd),
      } as unknown as ExtensionContext,
    });
    assert.deepEqual(result.decision, { status: "pass", violations: [], conflicts: [], decisionGate: null });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("independent auditor gathers evidence and submits one decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-behavior-"));
  try {
    await writeFile(join(cwd, "evidence.txt"), "court evidence: accepted\n");
    const sessionManager = SessionManager.inMemory(cwd);
    const baseTool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    let decisions = 0;
    const tool = { ...baseTool, async execute(...args: Parameters<typeof baseTool.execute>) { decisions += 1; return baseTool.execute(...args); } };
    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      if (turns === 1) return fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })], { stopReason: "toolUse" });
      assert.ok(context.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("court evidence: accepted")));
      return fauxAssistantMessage([fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })], { stopReason: "toolUse" });
    };
    const faux = fauxProvider({ provider: "audit-test" });
    faux.setResponses([complete, complete]);
    const decision = await runComplianceAudit({
      tool,
      systemPrompt: "Read the supplied evidence, then submit exactly one decision.",
      serializedInput: "Inspect evidence.txt and decide.",
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
    });
    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
