import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runGatekeeper, GATEKEEPER_OUTPUT_TOOL, INSPECTOR_OUTPUT_TOOL, NOTARY_OUTPUT_TOOL } from "../../src/gatekeeper-role.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import { packageRoot, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";

async function withParent(run: (context: any) => Promise<void>) {
  await withActivationHome({ prefix: "ak-gatekeeper-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      await run({ cwd: home, model, modelRegistry: { getProvider() { return undefined; }, async getProviderAuth() { return { auth: {} }; }, async getApiKeyAndHeaders() { return { ok: true }; } }, thinkingLevel: "off", sessionManager: session.sessionManager });
    });
  });
}

test("internal Gatekeeper dispatches worker completion to a real Inspector child and returns typed pass", async () => {
  const constitution = await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8");
  const qualityLaw = await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8");
  const gatekeeperSoul = await readFile(resolve(packageRoot, "souls/gatekeeper.md"), "utf8");
  const inspectorSoul = await readFile(resolve(packageRoot, "souls/inspector.md"), "utf8");
  const notarySoul = await readFile(resolve(packageRoot, "souls/notary.md"), "utf8");
  const overlay =
    "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。";

  await withParent(async (context) => {
    const seen: string[] = [];
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "implementation and test evidence" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
        { tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
      ], seen),
    });
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });
    assert.equal(seen.length, 2);
    // #443: default load injects factory constitution; inspector also gets quality-law.
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul, overlay].join("\n\n"),
    );
    assert.equal(
      seen[1],
      [constitution, inspectorSoul, qualityLaw, overlay].join("\n\n"),
    );
    assert.equal(seen[1]!.includes(notarySoul), false);
  });
});

test("Gatekeeper accepts its typed officer choice instead of machine-rejecting dispatch", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      subject: { kind: "judge_draft", material: "ticket and proposed judgment" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
        { tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
      ], []),
    });
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });
  });
});

test("internal Gatekeeper dispatches judge draft to Notary and bounce means rewrite", async () => {
  const constitution = await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8");
  const gatekeeperSoul = await readFile(resolve(packageRoot, "souls/gatekeeper.md"), "utf8");
  const notarySoul = await readFile(resolve(packageRoot, "souls/notary.md"), "utf8");
  const inspectorSoul = await readFile(resolve(packageRoot, "souls/inspector.md"), "utf8");
  const overlay =
    "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。";

  await withParent(async (context) => {
    const seen: string[] = [];
    const result = await runGatekeeper({
      context,
      subject: { kind: "judge_draft", material: "ticket and proposed judgment" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "notary" } },
        { tool: NOTARY_OUTPUT_TOOL, args: { status: "bounce", findings: ["quote has no source"] } },
      ], seen),
    });
    assert.deepEqual(result, { status: "bounce", officer: "notary", disposition: "rewrite", findings: ["quote has no source"] });
    assert.equal(seen.length, 2);
    // #443: Notary real entry receives factory constitution + notary soul (not inspector).
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul, overlay].join("\n\n"),
    );
    assert.equal(
      seen[1],
      [constitution, notarySoul, overlay].join("\n\n"),
    );
    assert.equal(seen[1]!.includes(inspectorSoul), false);
  });
});

test("Gatekeeper lets the role report typed incomplete for insufficient subject", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "incomplete", reason: "missing completion evidence" } },
      ], []),
    });
    assert.deepEqual(result, { status: "incomplete", stage: "gatekeeper", reason: "missing completion evidence" });
  });
});

test("Gatekeeper stage settlement without an accepted receipt is loud typed no_receipt", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
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
      assert.equal(result.stage, "gatekeeper");
      assert.equal(result.facts.sessionCompletion, "settled-without-accepted-receipt");
      assert.match(result.reason, /accepted receipt/i);
    }
  });
});

test("officer stage settlement without an accepted receipt is loud typed no_receipt", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
        { text: "not a receipt" },
        { text: "still not a receipt" },
        { text: "settled without a receipt" },
      ], []),
    });
    assert.equal(result.status, "no_receipt");
    if (result.status === "no_receipt") {
      assert.equal(result.stage, "inspector");
      assert.equal(result.facts.acceptedReceipt, false);
    }
  });
});

test("Gatekeeper child transport failure is loud and typed, never pass", async () => {
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      subject: { kind: "judge_draft", material: "draft" },
      runCompletion: async () => { throw new Error("provider disconnected"); },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "gatekeeper");
      assert.match(result.reason, /provider disconnected/);
    }
  });
});

test("Gatekeeper loadSoul native failure projects as typed transport_failure", async () => {
  await withParent(async (context) => {
    const missing = Object.assign(
      new Error("ENOENT: no such file or directory, open 'souls/__missing__.md'"),
      { code: "ENOENT" },
    );
    const result = await runGatekeeper({
      context,
      subject: { kind: "judge_draft", material: "draft" },
      loadSoul: async () => {
        throw missing;
      },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "gatekeeper");
      assert.match(result.reason, /ENOENT/);
    }
  });
});
