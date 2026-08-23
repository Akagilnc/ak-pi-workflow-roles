import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runMenxia, MENXIA_OUTPUT_TOOL, JISHIZHONG_OUTPUT_TOOL, FUBAOLANG_OUTPUT_TOOL } from "../../src/menxia-role.ts";
import { withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";

async function withParent(run: (context: any) => Promise<void>) {
  await withActivationHome({ prefix: "ak-menxia-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({ api: "menxia-parent", provider: "menxia-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      await run({ cwd: home, model, modelRegistry: { getProvider() { return undefined; }, async getProviderAuth() { return { auth: {} }; }, async getApiKeyAndHeaders() { return { ok: true }; } }, thinkingLevel: "off", sessionManager: session.sessionManager });
    });
  });
}

function completion(calls: Array<{ tool?: string; args?: object; text?: string }>, seen: string[]) {
  return async (_model: any, context: any) => {
    seen.push(context.systemPrompt);
    const next = calls.shift();
    if (!next) throw new Error("unexpected child turn");
    if (next.text !== undefined) return fauxAssistantMessage(next.text);
    return fauxAssistantMessage(fauxToolCall(next.tool!, next.args!, { id: `call-${seen.length}` }), { stopReason: "toolUse" });
  };
}

test("internal Menxia dispatches worker completion to a real Jishizhong child and returns typed pass", async () => {
  await withParent(async (context) => {
    const seen: string[] = [];
    const result = await runMenxia({
      context,
      subject: { kind: "worker_completion", material: "implementation and test evidence" },
      runCompletion: completion([
        { tool: MENXIA_OUTPUT_TOOL, args: { status: "dispatch", officer: "jishizhong" } },
        { tool: JISHIZHONG_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
      ], seen),
    });
    assert.deepEqual(result, { status: "pass", officer: "jishizhong", findings: [] });
    assert.equal(seen.length, 2);
    for (const prompt of seen) {
      assert.match(prompt, /取证工具不受白名单限制/);
      assert.match(prompt, /自行恢复/);
    }
  });
});

test("Menxia accepts its typed officer choice instead of machine-rejecting dispatch", async () => {
  await withParent(async (context) => {
    const result = await runMenxia({
      context,
      subject: { kind: "judge_draft", material: "ticket and proposed judgment" },
      runCompletion: completion([
        { tool: MENXIA_OUTPUT_TOOL, args: { status: "dispatch", officer: "jishizhong" } },
        { tool: JISHIZHONG_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
      ], []),
    });
    assert.deepEqual(result, { status: "pass", officer: "jishizhong", findings: [] });
  });
});

test("internal Menxia dispatches judge draft to Fubaolang and bounce means rewrite", async () => {
  await withParent(async (context) => {
    const result = await runMenxia({
      context,
      subject: { kind: "judge_draft", material: "ticket and proposed judgment" },
      runCompletion: completion([
        { tool: MENXIA_OUTPUT_TOOL, args: { status: "dispatch", officer: "fubaolang" } },
        { tool: FUBAOLANG_OUTPUT_TOOL, args: { status: "bounce", findings: ["quote has no source"] } },
      ], []),
    });
    assert.deepEqual(result, { status: "bounce", officer: "fubaolang", disposition: "rewrite", findings: ["quote has no source"] });
  });
});

test("Menxia lets the role report typed incomplete for insufficient subject", async () => {
  await withParent(async (context) => {
    const result = await runMenxia({
      context,
      subject: { kind: "worker_completion", material: "" },
      runCompletion: completion([
        { tool: MENXIA_OUTPUT_TOOL, args: { status: "incomplete", reason: "missing completion evidence" } },
      ], []),
    });
    assert.deepEqual(result, { status: "incomplete", stage: "menxia", reason: "missing completion evidence" });
  });
});

test("Menxia stage settlement without an accepted receipt is loud typed no_receipt", async () => {
  await withParent(async (context) => {
    const result = await runMenxia({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: completion([
        { text: "not a receipt" },
        { text: "still not a receipt" },
        { text: "settled without a receipt" },
      ], []),
    });
    assert.equal(result.status, "no_receipt");
    if (result.status === "no_receipt") {
      assert.equal(result.stage, "menxia");
      assert.equal(result.facts.sessionCompletion, "settled-without-accepted-receipt");
      assert.match(result.reason, /accepted receipt/i);
    }
  });
});

test("officer stage settlement without an accepted receipt is loud typed no_receipt", async () => {
  await withParent(async (context) => {
    const result = await runMenxia({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: completion([
        { tool: MENXIA_OUTPUT_TOOL, args: { status: "dispatch", officer: "jishizhong" } },
        { text: "not a receipt" },
        { text: "still not a receipt" },
        { text: "settled without a receipt" },
      ], []),
    });
    assert.equal(result.status, "no_receipt");
    if (result.status === "no_receipt") {
      assert.equal(result.stage, "jishizhong");
      assert.equal(result.facts.acceptedReceipt, false);
    }
  });
});

test("Menxia child transport failure is loud and typed, never pass", async () => {
  await withParent(async (context) => {
    const result = await runMenxia({
      context,
      subject: { kind: "judge_draft", material: "draft" },
      runCompletion: async () => { throw new Error("provider disconnected"); },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "menxia");
      assert.match(result.reason, /provider disconnected/);
    }
  });
});
