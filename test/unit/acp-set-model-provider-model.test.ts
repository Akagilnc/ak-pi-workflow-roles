/**
 * #644 / #1146 protocol probe: ACP set_model modelId follows each host catalog.
 * One external contract — fake ACP connection only; no real leg, no host home.
 * Paths are opaque coordinates (no real FS). #631 unit-tier honesty.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_DESCRIPTIONS } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

function fakeAcpConnection(
  calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }>,
  options?: { readonly setModelError?: Error },
): AcpConnection {
  return {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "sess-1" };
      if (method === "session/load") return { sessionId: params.sessionId ?? "sess-1" };
      if (method === "session/set_model") {
        if (options?.setModelError !== undefined) throw options.setModelError;
        return {};
      }
      if (method === "session/prompt") return { stopReason: "end_turn" };
      if (method === "session/close") return {};
      return {};
    },
    notify() {},
    async close() {},
  };
}

test("hermes set_model RPC modelId is seat provider:model", async () => {
  const hermes = HOST_DESCRIPTIONS.hermes;
  assert.ok(hermes);
  assert.equal(hermes.modelPassing, "set_model");

  // Opaque path coordinates only — fake connection never touches disk.
  const runDirectory = "/tmp/ak-set-model-pure";
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  const connection = fakeAcpConnection(calls);
  let rejectLoad = false;
  const host = createAcpRoleTurnHost({
    hostName: "hermes",
    modelPassing: hermes.modelPassing,
    setModelId: hermes.setModelId,
    sessionIdentity: {
      async load() {
        if (rejectLoad) throw new Error("explicit resume must use the stored host session id");
        return undefined;
      },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => connection,
    prepare: async () => ({
      mcpServers: [{ name: "ak-probe", type: "stdio" }],
      systemPrompt: { body: "probe", materials: [] },
      prompt: "probe",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() {
        return { accepted: true as const };
      },
    }),
  });

  const provider = "seat-provider";
  const model = "seat-model";
  const request: RoleTurnRequest = {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    model: { provider, model },
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
  const result = await host.executeTurn(request);
  assert.equal(result.knownFailure, undefined, JSON.stringify(result));
  assert.equal(result.code, 0);

  const setModel = calls.filter((c) => c.method === "session/set_model");
  assert.equal(setModel.length, 1);
  const methodsBeforePrompt = calls.slice(0, calls.findIndex((c) => c.method === "session/prompt")).map((c) => c.method);
  assert.ok(methodsBeforePrompt.includes("session/set_model"));

  rejectLoad = true;
  calls.length = 0;
  const resumed = await host.executeTurn({
    ...request,
    continuation: { kind: "resume", prompt: "again", hostSessionId: "stored-hermes-session" },
  });
  assert.equal(resumed.knownFailure, undefined, JSON.stringify(resumed));
  const loaded = calls.find((call) => call.method === "session/load");
  assert.equal(loaded?.params.sessionId, "stored-hermes-session");
  assert.deepEqual(setModel[0]?.params, {
    sessionId: "sess-1",
    modelId: `${provider}:${model}`,
  });
});

test("grok-build set_model RPC modelId is bare seat model before prompt", async () => {
  const grok = HOST_DESCRIPTIONS["grok-build"];
  assert.ok(grok);
  assert.equal(grok.modelPassing, "set_model");
  assert.equal(grok.setModelId, "bare");

  const runDirectory = "/tmp/ak-grok-set-model-pure";
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  const connection = fakeAcpConnection(calls);
  let rejectLoad = false;
  const host = createAcpRoleTurnHost({
    hostName: "grok-build",
    modelPassing: grok.modelPassing,
    setModelId: grok.setModelId,
    sessionIdentity: {
      async load() {
        if (rejectLoad) throw new Error("explicit resume must use the stored host session id");
        return undefined;
      },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => connection,
    prepare: async () => ({
      mcpServers: [{ name: "ak-probe", type: "stdio" }],
      systemPrompt: { body: "probe", materials: [] },
      prompt: "probe",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() {
        return { accepted: true as const };
      },
    }),
  });

  const provider = "xai";
  const model = "grok-4.5";
  const request: RoleTurnRequest = {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    model: { provider, model },
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
  const result = await host.executeTurn(request);
  assert.equal(result.knownFailure, undefined, JSON.stringify(result));
  assert.equal(result.code, 0);

  const setModel = calls.filter((c) => c.method === "session/set_model");
  assert.equal(setModel.length, 1);
  assert.deepEqual(setModel[0]?.params, {
    sessionId: "sess-1",
    modelId: model,
  });
  const promptIndex = calls.findIndex((c) => c.method === "session/prompt");
  assert.ok(promptIndex > 0);
  assert.ok(calls.slice(0, promptIndex).some((c) => c.method === "session/set_model"));

  rejectLoad = true;
  calls.length = 0;
  const resumed = await host.executeTurn({
    ...request,
    continuation: { kind: "resume", prompt: "again", hostSessionId: "stored-grok-session" },
  });
  assert.equal(resumed.knownFailure, undefined, JSON.stringify(resumed));
  const loaded = calls.find((call) => call.method === "session/load");
  assert.equal(loaded?.params.sessionId, "stored-grok-session");
  const resumeSetModel = calls.filter((c) => c.method === "session/set_model");
  assert.equal(resumeSetModel.length, 1);
  assert.deepEqual(resumeSetModel[0]?.params, {
    sessionId: "stored-grok-session",
    modelId: model,
  });
  const resumePromptIndex = calls.findIndex((c) => c.method === "session/prompt");
  assert.ok(resumePromptIndex > 0);
  assert.ok(calls.slice(0, resumePromptIndex).some((c) => c.method === "session/set_model"));

  calls.length = 0;
  const rejecting = fakeAcpConnection(calls, {
    setModelError: Object.assign(new Error("Invalid params"), {
      code: -32602,
      data: "unknown model id",
    }),
  });
  const failingHost = createAcpRoleTurnHost({
    hostName: "grok-build",
    modelPassing: grok.modelPassing,
    setModelId: grok.setModelId,
    sessionIdentity: {
      async load() { return undefined; },
      async bind() {},
      resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
    },
    connect: async () => rejecting,
    prepare: async () => ({
      mcpServers: [{ name: "ak-probe", type: "stdio" }],
      systemPrompt: { body: "probe", materials: [] },
      prompt: "probe",
      jsonSchema: { type: "object" },
      terminatingToolName: "ak_judge_output",
      async ingestStructuredOutput() {},
      async closeRound() {
        return { accepted: true as const };
      },
    }),
  });
  const failed = await failingHost.executeTurn(request);
  assert.notEqual(failed.knownFailure, undefined, JSON.stringify(failed));
  assert.equal(calls.some((c) => c.method === "session/prompt"), false);
  assert.equal(calls.filter((c) => c.method === "session/set_model").length, 1);
});
