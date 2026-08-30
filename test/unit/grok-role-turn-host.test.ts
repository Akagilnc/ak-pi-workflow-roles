import assert from "node:assert/strict";
import test from "node:test";

import { classifyGrokInspection, controlledGrokChildEnv, createGrokRoleTurnHost, type GrokAcpConnection } from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

const request = {
  principal: {}, activation: { role: "judge" }, methods: [],
  continuation: { kind: "initial", prompt: "decide" },
  model: { provider: "xai", model: "grok-4.5" }, cwd: "/work", home: "/home/user",
  agentDir: "/agent", runDirectory: "/run",
} as RoleTurnRequest;

test("grok host closes an accepted ACP turn through the typed round boundary", async () => {
  const calls: Array<[string, unknown]> = [];
  const connection: GrokAcpConnection = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === "initialize") return { agentCapabilities: { loadSession: true }, _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } } };
      if (method === "session/new") return { sessionId: "s1" };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      if (method === "session/close") return {};
      throw new Error(method);
    },
    notify(method, params) { calls.push([method, params]); },
    async close() {},
  };
  const host = createGrokRoleTurnHost({
    connect: async () => connection,
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
    prepare: async () => ({
      mcpServers: [{ name: "ak-role", command: "node", args: ["server.js"] }],
      systemPrompt: "law",
      closeRound: async () => ({ accepted: true }),
    }),
  });

  assert.deepEqual(await host.executeTurn(request), { code: 0, stderr: "", timedOut: false });
  assert.deepEqual(calls.map(([method]) => method), ["initialize", "session/new", "session/prompt", "session/close"]);
  assert.deepEqual(calls[1], ["session/new", { cwd: "/work", mcpServers: [{ name: "ak-role", command: "node", args: ["server.js"] }], _meta: { systemPromptOverride: "law" } }]);
});

test("grok host rejects a model absent from typed ACP capabilities", async () => {
  let prompted = false;
  const host = createGrokRoleTurnHost({
    connect: async () => ({
      async request(method) {
        if (method === "initialize") return { _meta: { modelState: { availableModels: [{ modelId: "grok-4.6" }] } } };
        prompted = true;
        return {};
      },
      notify() {},
      async close() {},
    }),
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
    prepare: async () => ({ mcpServers: [{}], systemPrompt: "law", closeRound: async () => ({ accepted: true }) }),
  });

  assert.deepEqual(await host.executeTurn(request), {
    code: null, stderr: "", timedOut: false,
    knownFailure: { cause: "activation", identity: { name: "GrokHostModelMismatch", code: "host-model-mismatch" }, details: { provider: "xai", model: "grok-4.5" } },
  });
  assert.equal(prompted, false);
});

test("grok host serializes concurrent ACP prompts", async () => {
  let activePrompts = 0;
  let maxActivePrompts = 0;
  let session = 0;
  const host = createGrokRoleTurnHost({
    connect: async () => ({
      async request(method) {
        if (method === "session/new") return { sessionId: `s${++session}` };
        if (method === "session/prompt") {
          maxActivePrompts = Math.max(maxActivePrompts, ++activePrompts);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activePrompts--;
          return { stopReason: "end_turn" };
        }
        return {};
      },
      notify() {},
      async close() {},
    }),
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
    prepare: async () => ({ mcpServers: [{}], systemPrompt: "law", closeRound: async () => ({ accepted: true }) }),
  });

  await Promise.all([host.executeTurn(request), host.executeTurn(request)]);
  assert.equal(maxActivePrompts, 1);
});

test("grok refusal is a typed failure and never closes the session as accepted", async () => {
  const calls: string[] = [];
  const host = createGrokRoleTurnHost({
    connect: async () => ({
      async request(method) {
        calls.push(method);
        if (method === "session/new") return { sessionId: "refused" };
        if (method === "session/prompt") return { stopReason: "refusal" };
        return {};
      },
      notify() {},
      async close() {},
    }),
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
    prepare: async () => ({ mcpServers: [{}], systemPrompt: "law", closeRound: async () => assert.fail("refusal must not close the ledger round") }),
  });

  const result = await host.executeTurn(request);
  assert.equal(result.knownFailure?.identity?.code, "refusal");
  assert.equal(calls.includes("session/close"), false);
});

test("grok host reports typed round closure failure instead of accepting no submission", async () => {
  const connection: GrokAcpConnection = {
    async request(method) {
      if (method === "session/new") return { sessionId: "s1" };
      return {};
    },
    notify() { assert.fail("unsealed round must not cancel as accepted"); },
    async close() {},
  };
  const knownFailure = { cause: "output", identity: { name: "MissingSubmission", code: "round-ended-without-submission" } } as const;
  const host = createGrokRoleTurnHost({
    connect: async () => connection,
    inspect: async () => ({ privateActive: [], akActive: [] }),
    prepare: async () => ({ mcpServers: [{}], systemPrompt: "law", closeRound: async () => ({ accepted: false, failure: knownFailure }) }),
  });
  assert.deepEqual(await host.executeTurn(request), { code: null, stderr: "", timedOut: false, knownFailure });
});

test("structured inspect classifies builtin, AK, and private sources by provenance", () => {
  assert.deepEqual(classifyGrokInspection({
    skills: [
      { name: "builtin", source: { type: "bundled" } },
      { name: "ak-method", source: { type: "project", path: "/pkg/resources/method/SKILL.md" } },
      { name: "private", source: { type: "user", path: "/home/.grok/skills/private/SKILL.md" } },
      { name: "disabled", disabled: true, source: { type: "user", path: "/home/disabled" } },
    ],
    plugins: [{ name: "private-plugin", enabled: true, path: "/home/plugin" }],
  }, "/pkg"), {
    privateActive: ["plugins:private-plugin", "skills:private"],
    akActive: ["skills:ak-method"],
  });
});

test("controlled child env disables every compat source with one parameterized rule", () => {
  const env = controlledGrokChildEnv({ PATH: "/bin" }, "/run/grok-home");
  for (const vendor of ["CLAUDE", "CURSOR", "CODEX"]) {
    for (const kind of ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"]) {
      assert.equal(env[`GROK_${vendor}_${kind}_ENABLED`], "false", `${vendor}/${kind}`);
    }
  }
  assert.equal(env.HOME, "/run/grok-home");
  assert.equal(env.GROK_HOME, "/run/grok-home");
  assert.equal(env.GROK_MEMORY, "0");
  assert.equal(env.GROK_SUBAGENTS, "0");
});

test("grok host rejects an uncontrolled personalized session before model work", async () => {
  let connected = false;
  const host = createGrokRoleTurnHost({
    connect: async () => { connected = true; throw new Error("must not connect"); },
    inspect: async () => ({ privateActive: ["user-plugin"], akActive: [] }),
    prepare: async () => ({ mcpServers: [], systemPrompt: "law", closeRound: async () => ({ accepted: true }) }),
  });
  assert.deepEqual(await host.executeTurn(request), {
    code: null, stderr: "", timedOut: false,
    knownFailure: { cause: "activation", identity: { name: "UncontrolledGrokSession", code: "private-config-active" }, details: { privateActive: ["user-plugin"] } },
  });
  assert.equal(connected, false);
});
