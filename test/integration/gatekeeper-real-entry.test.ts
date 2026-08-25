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
import {
  savePublicCliConfig,
  setPersistentSeatConfig,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import { packageRoot, withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { fauxProvider } from "@earendil-works/pi-ai";

type ParentRegistryOptions = {
  readonly find?: (provider: string, modelId: string) => unknown;
  readonly getApiKeyAndHeaders?: (model: unknown) => Promise<unknown>;
};

async function withParent(
  run: (context: any) => Promise<void>,
  registry: ParentRegistryOptions = {},
) {
  await withActivationHome({ prefix: "ak-gatekeeper-real-entry-" }, async ({ agentDir, home }) => {
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      await run({
        cwd: home,
        model,
        modelRegistry: {
          getProvider() { return undefined; },
          find(provider: string, modelId: string) {
            return registry.find?.(provider, modelId);
          },
          async getProviderAuth() { return { auth: {} }; },
          async getApiKeyAndHeaders(candidate: unknown) {
            if (registry.getApiKeyAndHeaders !== undefined) {
              return registry.getApiKeyAndHeaders(candidate);
            }
            return { ok: true };
          },
        },
        thinkingLevel: "off",
        sessionManager: session.sessionManager,
      });
    });
  });
}

function captureModels(
  calls: Array<{ tool?: string; args?: object | undefined; text?: string }>,
  models: Array<{ provider: string; id: string }>,
) {
  const inner = completion(calls, []);
  return async (model: any, context: any) => {
    models.push({ provider: model.provider, id: model.id });
    return inner(model, context);
  };
}

function fauxModel(provider: string, id: string) {
  return {
    api: "openai-responses" as const,
    provider,
    id,
    name: id,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

test("scripted Inspector pass projects typed receipt and loads Inspector session materials", async () => {
  const constitution = await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8");
  const qualityLaw = await readFile(resolve(packageRoot, "souls/quality-law.md"), "utf8");
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
    // #443: default load injects factory constitution; inspector also gets quality-law.
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul, overlay].join("\n\n"),
    );
    assert.equal(
      seen[1],
      [constitution, inspectorSoul, qualityLaw, overlay].join("\n\n"),
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
    // #443: scripted Notary real entry receives factory constitution + notary soul.
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul, overlay].join("\n\n"),
    );
    assert.equal(
      seen[1],
      [constitution, notarySoul, overlay].join("\n\n"),
    );
  });
});

test("Gatekeeper lets the role report typed incomplete for insufficient subject", async () => {
  await withParent(async (context) => {
    const incompleteSubmission = { status: "incomplete", reason: "missing completion evidence" };
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "" },
      runCompletion: completion([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: incompleteSubmission },
      ], []),
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") {
      assert.equal(result.stage, "gatekeeper");
      assert.equal(result.reason, "missing completion evidence");
      assert.deepEqual(result.submission, incompleteSubmission);
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

test("province submission without explicit dispatch is typed incomplete with original retained, never dispatch or pass", async () => {
  await withParent(async (context) => {
    const submission = { status: "pass", findings: [] };
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: completion([{ tool: GATEKEEPER_OUTPUT_TOOL, args: submission }], []),
    });
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") {
      assert.equal(result.stage, "gatekeeper");
      assert.deepEqual(result.submission, submission);
    }
  });
});

test("officer submission without explicit pass is typed incomplete at officer stage with original retained", async () => {
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
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") {
      assert.equal(result.stage, "inspector");
      assert.deepEqual(result.submission, submission);
    }
  });
});

test("missing arguments is one-shot incomplete with serializable typed observation", async () => {
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
    assert.equal(result.status, "incomplete");
    if (result.status === "incomplete") {
      assert.equal(result.stage, "gatekeeper");
      assert.deepEqual(result.submission, MISSING_ARGUMENTS_SUBMISSION);
    }
    // Typed observation must survive JSON session/tool_result projection.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(turns, 1);
  });
});

// #453: province child model selection through the real gatekeeper entry.
test("#453 unconfigured menxia seats inherit the parent session model", async () => {
  const seen: Array<{ provider: string; id: string }> = [];
  await withParent(async (context) => {
    const result = await runGatekeeper({
      context,
      subject: { kind: "worker_completion", material: "completion" },
      runCompletion: captureModels([
        { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
        { tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
      ], seen),
    });
    assert.equal(result.status, "pass");
    assert.deepEqual(seen, [
      { provider: context.model.provider, id: context.model.id },
      { provider: context.model.provider, id: context.model.id },
    ]);
  });
});

test("#453 gatekeeper-only config is inherited by inspector and notary", async () => {
  const gateModel = fauxModel("xai", "gate-only-model");
  await withActivationHome({ prefix: "ak-gatekeeper-model-gate-" }, async ({ home, agentDir }) => {
    await savePublicCliConfig(
      setPersistentSeatConfig({ seats: {} }, "gatekeeper", {
        provider: "xai",
        model: "gate-only-model",
        thinking: "high",
      }),
      home,
    );
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      for (const officer of ["inspector", "notary"] as const) {
        const seen: Array<{ provider: string; id: string }> = [];
        const result = await runGatekeeper({
          context: {
            cwd: home,
            model,
            modelRegistry: {
              getProvider() { return undefined; },
              find(provider: string, modelId: string) {
                if (provider === "xai" && modelId === "gate-only-model") return gateModel;
                return undefined;
              },
              async getProviderAuth() { return { auth: {} }; },
              async getApiKeyAndHeaders() { return { ok: true }; },
            },
            thinkingLevel: "off",
            sessionManager: session.sessionManager,
          } as any,
          subject: { kind: "worker_completion", material: "completion" },
          runCompletion: captureModels([
            { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer } },
            {
              tool: officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL,
              args: { status: "pass", findings: [] },
            },
          ], seen),
        });
        assert.equal(result.status, "pass");
        assert.deepEqual(seen, [
          { provider: "xai", id: "gate-only-model" },
          { provider: "xai", id: "gate-only-model" },
        ]);
      }
    });
  });
});

test("#453 inspector and notary persistent overrides do not cross wires", async () => {
  const models = {
    gate: fauxModel("xai", "gate-model"),
    inspector: fauxModel("openai-codex", "inspector-model"),
    notary: fauxModel("openai-codex", "notary-model"),
  };
  await withActivationHome({ prefix: "ak-gatekeeper-model-own-" }, async ({ home, agentDir }) => {
    let config: PublicCliConfig = { seats: {} };
    config = setPersistentSeatConfig(config, "gatekeeper", {
      provider: "xai", model: "gate-model", thinking: "high",
    });
    config = setPersistentSeatConfig(config, "inspector", {
      provider: "openai-codex", model: "inspector-model", thinking: "medium",
    });
    config = setPersistentSeatConfig(config, "notary", {
      provider: "openai-codex", model: "notary-model", thinking: "high",
    });
    await savePublicCliConfig(config, home);
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      const registry = {
        getProvider() { return undefined; },
        find(provider: string, modelId: string) {
          if (provider === "xai" && modelId === "gate-model") return models.gate;
          if (provider === "openai-codex" && modelId === "inspector-model") return models.inspector;
          if (provider === "openai-codex" && modelId === "notary-model") return models.notary;
          return undefined;
        },
        async getProviderAuth() { return { auth: {} }; },
        async getApiKeyAndHeaders() { return { ok: true }; },
      };
      const context = {
        cwd: home,
        model,
        modelRegistry: registry,
        thinkingLevel: "off" as const,
        sessionManager: session.sessionManager,
      } as any;

      const inspectorSeen: Array<{ provider: string; id: string }> = [];
      const inspectorResult = await runGatekeeper({
        context,
        subject: { kind: "worker_completion", material: "completion" },
        runCompletion: captureModels([
          { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "inspector" } },
          { tool: INSPECTOR_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
        ], inspectorSeen),
      });
      assert.equal(inspectorResult.status, "pass");
      assert.deepEqual(inspectorSeen, [
        { provider: "xai", id: "gate-model" },
        { provider: "openai-codex", id: "inspector-model" },
      ]);

      const notarySeen: Array<{ provider: string; id: string }> = [];
      const notaryResult = await runGatekeeper({
        context,
        subject: { kind: "judge_draft", material: "draft" },
        runCompletion: captureModels([
          { tool: GATEKEEPER_OUTPUT_TOOL, args: { status: "dispatch", officer: "notary" } },
          { tool: NOTARY_OUTPUT_TOOL, args: { status: "pass", findings: [] } },
        ], notarySeen),
      });
      assert.equal(notaryResult.status, "pass");
      assert.deepEqual(notarySeen, [
        { provider: "xai", id: "gate-model" },
        { provider: "openai-codex", id: "notary-model" },
      ]);
    });
  });
});

test("#453 explicit menxia model auth failure does not fall back to parent", async () => {
  const gateModel = fauxModel("xai", "auth-fail-model");
  await withActivationHome({ prefix: "ak-gatekeeper-model-auth-" }, async ({ home, agentDir }) => {
    await savePublicCliConfig(
      setPersistentSeatConfig({ seats: {} }, "gatekeeper", {
        provider: "xai",
        model: "auth-fail-model",
      }),
      home,
    );
    const faux = fauxProvider({ api: "gatekeeper-parent", provider: "gatekeeper-parent", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([fauxAssistantMessage("parent")]);
    await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, noTools: "builtin", mode: "print", systemPrompt: "BASE", flags: {} }, async ({ session, model }) => {
      let completionCalls = 0;
      const result = await runGatekeeper({
        context: {
          cwd: home,
          model,
          modelRegistry: {
            getProvider() { return undefined; },
            find(provider: string, modelId: string) {
              if (provider === "xai" && modelId === "auth-fail-model") return gateModel;
              return undefined;
            },
            async getProviderAuth() { return { auth: {} }; },
            async getApiKeyAndHeaders(candidate: any) {
              if (candidate?.id === "auth-fail-model") {
                return { ok: false, error: "override credentials missing" };
              }
              return { ok: true };
            },
          },
          thinkingLevel: "off",
          sessionManager: session.sessionManager,
        } as any,
        subject: { kind: "worker_completion", material: "completion" },
        runCompletion: async () => {
          completionCalls += 1;
          throw new Error("must not reach child completion after auth failure");
        },
      });
      assert.equal(result.status, "transport_failure");
      if (result.status === "transport_failure") {
        assert.equal(result.stage, "gatekeeper");
        assert.match(result.reason, /authentication failed|override credentials missing/i);
      }
      assert.equal(completionCalls, 0);
    });
  });
});
