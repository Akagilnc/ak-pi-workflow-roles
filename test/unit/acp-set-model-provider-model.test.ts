/**
 * #644 protocol probe: set_model hosts receive seat provider:model, never bare model.
 * Fake ACP connection only — no real leg, no model brand lock, no ~/.hermes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acpModelId,
  type AcpHostDescription,
} from "../../src/acp-host/description.ts";
import {
  createAcpRoleTurnHost,
  type AcpConnection,
  type AcpPreparedTurn,
} from "../../src/acp-host/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { HOST_DESCRIPTIONS } from "../../src/host-descriptions.ts";
import { applyProviderHostAlias } from "../../src/public-cli/config.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

type RpcCall = {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
};

function fakeConnection(calls: RpcCall[]): AcpConnection {
  return {
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
}

function prepared(): AcpPreparedTurn {
  return {
    mcpServers: [{ name: "ak-probe", type: "stdio" }],
    systemPrompt: { body: "probe", materials: [] },
    prompt: "probe",
    async closeRound() {
      return { accepted: true as const };
    },
  };
}

async function withRunDir(fn: (runDirectory: string) => Promise<void>): Promise<void> {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-set-model-"));
  try {
    await fn(runDirectory);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

function baseRequest(
  runDirectory: string,
  model: RoleTurnRequest["model"],
): RoleTurnRequest {
  const sessionDirectory = join(runDirectory, "session");
  return {
    principal: fixturePrincipal(sessionDirectory),
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "probe" },
    ...(model === undefined ? {} : { model }),
    cwd: runDirectory,
    home: runDirectory,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

test("hermes description row is set_model (provider:model path)", () => {
  assert.equal(HOST_DESCRIPTIONS.hermes?.modelPassing, "set_model");
  assert.equal(HOST_DESCRIPTIONS["grok-build"]?.modelPassing, "argv");
});

test("acpModelId concatenates provider:model only for set_model hosts", () => {
  const seat = { provider: "seat-provider", model: "seat-model" };
  assert.equal(acpModelId("set_model", seat), "seat-provider:seat-model");
  assert.equal(acpModelId("argv", seat), "seat-model");
  // Missing provider must not emit a bare or undefined-qualified modelId.
  assert.equal(acpModelId("set_model", { model: "seat-model" }), undefined);
  assert.equal(acpModelId("set_model", { provider: "  ", model: "seat-model" }), undefined);
});

test("owner host alias feeds the same concatenation (no package provider map)", () => {
  const seat = { provider: "pi-name", model: "m1", thinking: "high" as const };
  const projected = applyProviderHostAlias(seat, "hermes", {
    "pi-name": { hermes: "host-name" },
  });
  assert.deepEqual(projected, { provider: "host-name", model: "m1", thinking: "high" });
  assert.equal(acpModelId("set_model", projected), "host-name:m1");
  // Unregistered pair stays pass-through.
  assert.equal(
    acpModelId("set_model", applyProviderHostAlias(seat, "hermes", undefined)),
    "pi-name:m1",
  );
});

test("set_model RPC receives provider:model from the seat model on the ACP host entry", async () => {
  await withRunDir(async (runDirectory) => {
    const calls: RpcCall[] = [];
    const host = createAcpRoleTurnHost({
      modelPassing: "set_model",
      boundResume: "session/load",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
      },
      connect: async () => fakeConnection(calls),
      prepare: async () => prepared(),
    });

    const provider = "alias-or-seat-provider";
    const model = "fixture-model";
    const result = await host.executeTurn(
      baseRequest(runDirectory, { provider, model, thinking: "high" }),
    );
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    assert.equal(result.code, 0);

    const setModel = calls.filter((c) => c.method === "session/set_model");
    assert.equal(setModel.length, 1);
    assert.deepEqual(setModel[0]?.params, {
      sessionId: "sess-1",
      modelId: `${provider}:${model}`,
    });
    // Bare model name must not appear as modelId.
    assert.notEqual(setModel[0]?.params.modelId, model);
  });
});

test("argv modelPassing never issues session/set_model", async () => {
  await withRunDir(async (runDirectory) => {
    const calls: RpcCall[] = [];
    const host = createAcpRoleTurnHost({
      modelPassing: "argv",
      boundResume: "session/load",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
      },
      connect: async () => fakeConnection(calls),
      prepare: async () => prepared(),
    });

    await host.executeTurn(
      baseRequest(runDirectory, { provider: "any", model: "m", thinking: "low" }),
    );
    assert.equal(calls.some((c) => c.method === "session/set_model"), false);
  });
});

test("set_model host skips RPC when provider is absent (no bare-model fallback)", async () => {
  await withRunDir(async (runDirectory) => {
    const calls: RpcCall[] = [];
    const host = createAcpRoleTurnHost({
      modelPassing: "set_model" satisfies AcpHostDescription["modelPassing"],
      boundResume: "session/load",
      sessionIdentity: {
        async load() {
          return undefined;
        },
        async bind() {},
        resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
      },
      connect: async () => fakeConnection(calls),
      prepare: async () => prepared(),
    });

    // Structural hole only — production RoleTurnModelConfig requires provider.
    await host.executeTurn(
      baseRequest(runDirectory, { provider: "", model: "orphan-model" }),
    );
    assert.equal(calls.some((c) => c.method === "session/set_model"), false);
  });
});
