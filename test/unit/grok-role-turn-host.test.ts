import assert from "node:assert/strict";
import test from "node:test";

import { classifyGrokInspection, controlledGrokChildEnv, createGrokRoleTurnHost, type GrokAcpConnection } from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

const sessionIds = new WeakMap<object, string>();
const sessionIdentity = {
  async load(principal: object) { return sessionIds.get(principal); },
  async bind(principal: object, sessionId: string) { sessionIds.set(principal, sessionId); },
};

const request = {
  principal: {}, activation: { role: "judge" }, methods: [],
  continuation: { kind: "initial", prompt: "decide" },
  model: { provider: "xai", model: "grok-4.5" }, cwd: "/work", home: "/home/user",
  agentDir: "/agent", runDirectory: "/run",
} as RoleTurnRequest;

test("grok host closes an accepted ACP turn through the typed round boundary", async () => {
  const calls: Array<[string, unknown]> = [];
  const capabilities: unknown[] = [];
  const connection: GrokAcpConnection = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === "initialize") return { agentCapabilities: { loadSession: true }, _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] }, "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny"] } } };
      if (method === "session/new") return { sessionId: "s1" };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      if (method === "session/close") return {};
      throw new Error(method);
    },
    notify(method, params) { calls.push([method, params]); },
    async close() {},
  };
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async (_request, declaration) => { capabilities.push(declaration); },
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
  assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: false }]);
  assert.deepEqual(calls[1], ["session/new", { cwd: "/work", mcpServers: [{ name: "ak-role", command: "node", args: ["server.js"] }], _meta: { systemPromptOverride: "law", yoloMode: false } }]);
});

test("grok session identity is bound by its authority and decoded for resume", async () => {
  const durableRequest = { ...request, principal: {} } as RoleTurnRequest;
  const sessionCalls: Array<[string, unknown]> = [];
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
    connect: async () => ({
      async request(method, params) {
        sessionCalls.push([method, params]);
        if (method === "session/new") return { sessionId: "durable-s1" };
        return method === "session/prompt" ? { stopReason: "end_turn" } : {};
      },
      notify() {},
      async close() {},
    }),
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
    prepare: async () => ({ mcpServers: [{}], systemPrompt: "law", closeRound: async () => ({ accepted: true }) }),
  });

  await host.executeTurn(durableRequest);
  await host.executeTurn({ ...durableRequest, continuation: { kind: "resume", prompt: "again" } });
  const load = sessionCalls.find(([method]) => method === "session/load");
  assert.deepEqual(load, ["session/load", { sessionId: "durable-s1", cwd: "/work", mcpServers: [{}], _meta: { systemPromptOverride: "law", yoloMode: false } }]);
});

test("grok host rejects a model absent from typed ACP capabilities", async () => {
  let prompted = false;
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
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
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstPromptStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  let promptCount = 0;
  let session = 0;
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
    connect: async () => ({
      async request(method) {
        if (method === "session/new") return { sessionId: `s${++session}` };
        if (method === "session/prompt") {
          promptCount++;
          if (promptCount === 1) {
            firstStarted();
            await firstBlocked;
          }
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

  const first = host.executeTurn(request);
  const second = host.executeTurn(request);
  await firstPromptStarted;
  assert.equal(promptCount, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(promptCount, 2);
});

test("grok refusal is a typed failure and never closes the session as accepted", async () => {
  const calls: string[] = [];
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
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
    sessionIdentity,
    recordCapabilities: async () => {},
    connect: async () => connection,
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
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
    agents: [{ name: "private-agent", source: { type: "user", path: "/home/.grok/agents/private.md" } }],
    plugins: [{ name: "private-plugin", enabled: true, path: "/home/plugin" }],
    mcpServers: [{ name: "private-mcp", source: { type: "user", path: "/home/.grok/mcp.json" } }],
    hooks: [
      { name: "private-hook", source: { type: "user", path: "/home/.grok/hooks.json" } },
      { name: "disabled-hook", compatibilityStatus: "disabled", source: { type: "user", path: "/home/.grok/hooks.json" } },
    ],
    projectInstructions: [
      { path: "/pkg/CLAUDE.md", scope: "project" },
      { path: "/home/.claude/CLAUDE.md", scope: "global", disabled: true },
    ],
  }, "/pkg"), {
    privateActive: ["agents:private-agent", "hooks:private-hook", "mcpServers:private-mcp", "plugins:private-plugin", "skills:private"],
    akActive: ["projectInstructions:/pkg/CLAUDE.md", "skills:ak-method"],
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
    sessionIdentity,
    recordCapabilities: async () => {},
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
