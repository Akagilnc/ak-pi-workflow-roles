import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  decideGrokPreToolUse,
  GROK_BASH_SEATBELT_LITERALS,
  installGrokPreToolUseDeny,
  matchGrokBashSeatbeltLiteral,
} from "../../src/grok/bash-seatbelt.ts";
import { classifyGrokInspection, controlledGrokChildEnv, createGrokRoleTurnHost, type GrokAcpConnection, type GrokPreparedTurn } from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

const sessionIds = new WeakMap<object, string>();
const sessionIdentity = {
  async load(principal: object) { return sessionIds.get(principal); },
  async bind(principal: object, sessionId: string) { sessionIds.set(principal, sessionId); },
};

async function withControlledHome(
  run: (home: string, request: RoleTurnRequest) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-host-"));
  try {
    const request = {
      principal: {}, activation: { role: "judge" }, methods: [],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" }, cwd: "/work", home,
      agentDir: join(home, "agent"), runDirectory: join(home, "run"),
    } as RoleTurnRequest;
    await run(home, request);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function prepared(closeRound: GrokPreparedTurn["closeRound"], mcpServers: Readonly<Record<string, unknown>>[] = [{}]): GrokPreparedTurn {
  return {
    mcpServers,
    systemPrompt: "law",
    prompt: "decide",
    closeRound,
  };
}

test("grok host closes an accepted ACP turn through the typed round boundary", async () => {
  await withControlledHome(async (home, request) => {
    const calls: Array<[string, unknown]> = [];
    const capabilities: unknown[] = [];
    const connection: GrokAcpConnection = {
      async request(method, params) {
        calls.push([method, params]);
        if (method === "initialize") {
          return {
            agentCapabilities: { loadSession: true },
            _meta: {
              modelState: { availableModels: [{ modelId: "grok-4.5" }] },
              "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny"] },
            },
          };
        }
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
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role", command: "node", args: ["server.js"] }]),
    });

    assert.deepEqual(await host.executeTurn(request), { code: 0, stderr: "", timedOut: false });
    assert.deepEqual(calls.map(([method]) => method), ["initialize", "session/new", "session/prompt", "session/close"]);
    assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: true }]);
    // Capability true only after a real seatbelt landed in the controlled home.
    const hookJson = await readFile(join(home, "hooks", "ak-bash-seatbelt.json"), "utf8");
    assert.equal(JSON.parse(hookJson).hooks.PreToolUse[0].matcher, "Bash|run_terminal_command");
    assert.deepEqual(calls[1], ["session/new", {
      cwd: "/work",
      mcpServers: [{ name: "ak-role", command: "node", args: ["server.js"] }],
      _meta: { systemPromptOverride: "law", yoloMode: false },
    }]);
  });
});

test("grok host records preToolUseDeny false when the host cannot deny", async () => {
  await withControlledHome(async (home, request) => {
    const capabilities: unknown[] = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async (_request, declaration) => { capabilities.push(declaration); },
      connect: async () => ({
        async request(method) {
          if (method === "initialize") return { _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } } };
          if (method === "session/new") return { sessionId: "s1" };
          if (method === "session/prompt") return { stopReason: "end_turn" };
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => prepared(async () => ({ accepted: true })),
    });
    assert.equal((await host.executeTurn(request)).code, 0);
    assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: false }]);
    await assert.rejects(readFile(join(home, "hooks", "ak-bash-seatbelt.json")));
  });
});

test("bash seatbelt denies one representative dangerous command and shares one rule across four literals", async () => {
  const denied = decideGrokPreToolUse({
    toolName: "run_terminal_command",
    toolInput: { command: "rm -rf /tmp/x" },
  });
  assert.deepEqual(denied, {
    decision: "deny",
    reason: "修内司 bash 拦截：命中禁用字面量 rm -rf",
  });
  assert.deepEqual(
    decideGrokPreToolUse({ toolName: "run_terminal_command", toolInput: { command: "ls -la" } }),
    { decision: "allow" },
  );
  for (const literal of GROK_BASH_SEATBELT_LITERALS) {
    assert.equal(matchGrokBashSeatbeltLiteral(`prefix ${literal} suffix`), literal);
    assert.equal(
      decideGrokPreToolUse({ toolInput: { command: `echo; ${literal}` } }).decision,
      "deny",
      literal,
    );
  }
});

test("installed seatbelt hook script emits structured deny without aborting the process", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-seatbelt-hook-"));
  try {
    await installGrokPreToolUseDeny(home);
    const script = join(home, "hooks", "ak-bash-seatbelt.mjs");
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`hook exited ${String(code)}: ${err}`));
      });
      child.stdin.end(JSON.stringify({
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_command",
        toolInput: { command: "rm -rf /tmp/danger" },
      }));
    });
    assert.deepEqual(JSON.parse(stdout), {
      decision: "deny",
      reason: "修内司 bash 拦截：命中禁用字面量 rm -rf",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("grok session identity is bound by its authority and decoded for resume", async () => {
  await withControlledHome(async (_home, request) => {
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
      prepare: async () => prepared(async () => ({ accepted: true })),
    });

    await host.executeTurn(durableRequest);
    await host.executeTurn({ ...durableRequest, continuation: { kind: "resume", prompt: "again" } });
    const load = sessionCalls.find(([method]) => method === "session/load");
    assert.deepEqual(load, ["session/load", {
      sessionId: "durable-s1",
      cwd: "/work",
      mcpServers: [{}],
      _meta: { systemPromptOverride: "law", yoloMode: false },
    }]);
  });
});

test("grok host rejects a model absent from typed ACP capabilities", async () => {
  await withControlledHome(async (_home, request) => {
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
      prepare: async () => prepared(async () => ({ accepted: true })),
    });

    assert.deepEqual(await host.executeTurn(request), {
      code: null, stderr: "", timedOut: false,
      knownFailure: {
        cause: "activation",
        identity: { name: "GrokHostModelMismatch", code: "host-model-mismatch" },
        details: { provider: "xai", model: "grok-4.5" },
      },
    });
    assert.equal(prompted, false);
  });
});

test("grok host serializes concurrent ACP prompts", async () => {
  await withControlledHome(async (_home, request) => {
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
      prepare: async () => prepared(async () => ({ accepted: true })),
    });

    const first = host.executeTurn(request);
    const second = host.executeTurn(request);
    await firstPromptStarted;
    assert.equal(promptCount, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(promptCount, 2);
  });
});

test("grok refusal is a typed failure and cancels instead of closing as accepted", async () => {
  await withControlledHome(async (_home, request) => {
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
        notify(method) { calls.push(method); },
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => prepared(async () => assert.fail("refusal must not close the ledger round")),
    });

    const result = await host.executeTurn(request);
    assert.equal(result.knownFailure?.identity?.code, "refusal");
    assert.equal(calls.includes("session/close"), false);
    assert.equal(calls.includes("session/cancel"), true);
  });
});

test("grok host delivers a typed rejection and resubmits in the same ACP session", async () => {
  await withControlledHome(async (_home, request) => {
    const prompts: unknown[] = [];
    let rounds = 0;
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          if (method === "session/new") return { sessionId: "retry-session" };
          if (method === "session/prompt") { prompts.push(params); return { stopReason: "end_turn" }; }
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => prepared(async () => ++rounds === 1
        ? { accepted: false, retry: { code: "non-sole-round", toolCallIds: ["bad"] } }
        : { accepted: true }),
    });

    assert.equal((await host.executeTurn(request)).code, 0);
    assert.equal(prompts.length, 2);
    assert.equal((prompts[0] as { sessionId: string }).sessionId, "retry-session");
    assert.equal((prompts[1] as { sessionId: string }).sessionId, "retry-session");
  });
});

test("grok host reports typed round closure failure instead of accepting no submission", async () => {
  await withControlledHome(async (_home, request) => {
    const cancels: unknown[] = [];
    const knownFailure = {
      cause: "output",
      identity: { name: "MissingSubmission", code: "round-ended-without-submission" },
    } as const;
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method) {
          if (method === "session/new") return { sessionId: "s1" };
          return {};
        },
        // Do not assert.fail here: production swallows notify errors in finally.
        notify(method, params) { cancels.push([method, params]); },
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => prepared(async () => ({ accepted: false, failure: knownFailure })),
    });
    assert.deepEqual(await host.executeTurn(request), { code: null, stderr: "", timedOut: false, knownFailure });
    assert.deepEqual(cancels, [["session/cancel", { sessionId: "s1" }]]);
  });
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
    externalCompat: { cells: [
      { vendor: "claude", surface: "hooks", enabled: false },
      { vendor: "cursor", surface: "mcps", enabled: true },
    ] },
    projectInstructions: [
      { path: "/pkg/CLAUDE.md", scope: "project" },
      { path: "/home/.claude/CLAUDE.md", scope: "global", disabled: true },
    ],
  }, "/pkg"), {
    privateActive: ["agents:private-agent", "externalCompat:cursor:mcps", "hooks:private-hook", "mcpServers:private-mcp", "plugins:private-plugin", "skills:private"],
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
  await withControlledHome(async (_home, request) => {
    let connected = false;
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => { connected = true; throw new Error("must not connect"); },
      inspect: async () => ({ privateActive: ["user-plugin"], akActive: [] }),
      prepare: async () => prepared(async () => ({ accepted: true })),
    });
    assert.deepEqual(await host.executeTurn(request), {
      code: null, stderr: "", timedOut: false,
      knownFailure: {
        cause: "activation",
        identity: { name: "UncontrolledGrokSession", code: "private-config-active" },
        details: { privateActive: ["user-plugin"] },
      },
    });
    assert.equal(connected, false);
  });
});
