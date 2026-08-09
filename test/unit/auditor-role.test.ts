import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createComplianceDecisionTool, runComplianceAudit } from "../../src/compliance-transport.ts";

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
