/**
 * #644 protocol probe: hermes set_model receives seat provider:model.
 * One external contract — fake ACP connection only; no real leg, no ~/.hermes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_DESCRIPTIONS } from "../../src/host-descriptions.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

test("hermes set_model RPC modelId is seat provider:model", async () => {
  const hermes = HOST_DESCRIPTIONS.hermes;
  assert.ok(hermes);
  assert.equal(hermes.modelPassing, "set_model");

  const runDirectory = await mkdtemp(join(tmpdir(), "ak-set-model-"));
  const calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
  try {
    const connection: AcpConnection = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") return { sessionId: "sess-1" };
        if (method === "session/load") return { sessionId: params.sessionId ?? "sess-1" };
        if (method === "session/set_model") return {};
        if (method === "session/prompt") return { stopReason: "end_turn" };
        if (method === "session/close") return {};
        return {};
      },
      notify() {},
      async close() {},
    };
    const host = createAcpRoleTurnHost({
      hostName: "hermes",
      modelPassing: hermes.modelPassing,
      boundResume: hermes.boundResume,
      sessionIdentity: {
        async load() {
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
    assert.deepEqual(setModel[0]?.params, {
      sessionId: "sess-1",
      modelId: `${provider}:${model}`,
    });
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
