import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, validateToolArguments } from "@earendil-works/pi-ai";
import {
  runGatekeeper,
  GATEKEEPER_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  NOTARY_OUTPUT_TOOL,
  MISSING_ARGUMENTS_SUBMISSION,
  createGatekeeperOutputTool,
  createOfficerDecisionTool,
} from "../../src/gatekeeper-role.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import { packageRoot, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";

async function withParent(run: (context: any) => Promise<void>) {
  await withActivationHome({ prefix: "ak-gatekeeper-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      await run({
        cwd: home,
        model,
        modelRegistry: {
          getProvider() { return undefined; },
          find() { return model; },
          async getProviderAuth() { return { auth: {} }; },
          async getApiKeyAndHeaders() { return { ok: true }; },
        },
        thinkingLevel: "off",
        sessionManager: session.sessionManager,
      });
    });
  });
}

test("scripted Inspector pass projects typed receipt and loads Inspector session materials", async () => {
  const constitution = await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8");
  const qualityLaw = await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8");
  const menxiaGuide = await readFile(resolve(packageRoot, "souls/gate-output-guide.md"), "utf8");
  const gatekeeperSoul = await readFile(resolve(packageRoot, "souls/gatekeeper.md"), "utf8");
  const inspectorSoul = await readFile(resolve(packageRoot, "souls/inspector.md"), "utf8");
  const overlay =
    "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。";

  await withParent(async (context) => {
    const seen: string[] = [];
    // Subject kind is a fixture input only — officer choice is scripted, not an oracle on subject.
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "implementation and test evidence" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
        { tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
      ], seen),
    });
    // Mechanical projection of the scripted officer receipt; session order Gatekeeper → officer.
    assert.deepEqual(result, { status: "pass", officer: "inspector", findings: [] });
    assert.equal(seen.length, 2);
    // #443/#476: constitution + soul + menxia guide; inspector also gets quality-law.
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul, menxiaGuide, overlay].join("\n\n"),
    );
    assert.equal(
      seen[1],
      [constitution, inspectorSoul, qualityLaw, menxiaGuide, overlay].join("\n\n"),
    );
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

test("scripted officer bounce projects rewrite disposition and loads that officer's session materials", async () => {
  const constitution = await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8");
  const menxiaGuide = await readFile(resolve(packageRoot, "souls/gate-output-guide.md"), "utf8");
  const gatekeeperSoul = await readFile(resolve(packageRoot, "souls/gatekeeper.md"), "utf8");
  const notarySoul = await readFile(resolve(packageRoot, "souls/notary.md"), "utf8");
  const overlay =
    "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。";

  await withParent(async (context) => {
    const seen: string[] = [];
    // Subject kind is a fixture input only — bounce→rewrite is the mechanical contract under test.
    const bounceSubmission = { status: "bounce", findings: ["quote has no source"] };
    const result = await runGatekeeper({
      context,
      subject: { kind: "judge_draft", material: "ticket and proposed judgment" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "notary" } },
        { tool: NOTARY_OUTPUT_TOOL, args: bounceSubmission },
      ], seen),
    });
    assert.equal(result.status, "bounce");
    if (result.status === "bounce") {
      assert.equal(result.officer, "notary");
      assert.equal(result.disposition, "rewrite");
      assert.deepEqual(result.findings, ["quote has no source"]);
      assert.deepEqual(result.submission, bounceSubmission);
    }
    assert.equal(seen.length, 2);
    // #443/#476: scripted Notary real entry receives constitution + soul + menxia guide.
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul, menxiaGuide, overlay].join("\n\n"),
    );
    assert.equal(
      seen[1],
      [constitution, notarySoul, menxiaGuide, overlay].join("\n\n"),
    );
  });
});

test("Gatekeeper maps non-dispatch submission to transport_failure with original retained", async () => {
  await withParent(async (context) => {
    const badSubmission = { status: "incomplete", reason: "missing completion evidence" };
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: badSubmission },
      ], []),
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "gatekeeper");
      assert.deepEqual(result.submission, badSubmission);
    }
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

test("Gatekeeper and shared officer decision tools accept malformed object submissions once", () => {
  const malformed = { status: "not-a-legal-status", extra: true, findings: "not-array" };
  const province = createGatekeeperOutputTool();
  const officer = createOfficerDecisionTool(INSPECTOR_OUTPUT_TOOL);
  assert.deepEqual(
    validateToolArguments(province as never, {
      id: "province-malformed",
      name: province.name,
      arguments: structuredClone(malformed),
    } as never),
    malformed,
  );
  assert.deepEqual(
    validateToolArguments(officer as never, {
      id: "officer-malformed",
      name: officer.name,
      arguments: structuredClone(malformed),
    } as never),
    malformed,
  );
});

test("province submission without explicit dispatch is transport_failure with original retained, never dispatch or pass", async () => {
  await withParent(async (context) => {
    const submission = { status: "pass", findings: [] };
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: completion([{ tool: GATEKEEPER_OUTPUT_TOOL, args: submission }], []),
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "gatekeeper");
      assert.deepEqual(result.submission, submission);
    }
  });
});

test("officer submission without explicit pass is transport_failure at officer stage with original retained", async () => {
  await withParent(async (context) => {
    const submission = { status: "ok-enough" };
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
        { tool: INSPECTOR_OUTPUT_TOOL, args: submission },
      ], []),
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "inspector");
      assert.deepEqual(result.submission, submission);
    }
  });
});

test("missing arguments is one-shot transport_failure with serializable typed observation", async () => {
  await withParent(async (context) => {
    let turns = 0;
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: async (model, ctx) => {
        turns += 1;
        if (turns > 1) throw new Error("must not retry after missing-arguments submission");
        return completion([{ tool: GATEKEEPER_OUTPUT_TOOL, args: undefined }], [])(model, ctx);
      },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "gatekeeper");
      assert.deepEqual(result.submission, MISSING_ARGUMENTS_SUBMISSION);
    }
    // Typed observation must survive JSON session/tool_result projection.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(turns, 1);
  });
});
