import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyGrokInspection,
  controlledGrokChildEnv,
  createGrokRoleTurnHost,
  type GrokAcpConnection,
  type GrokPreparedTurn,
  type GrokSessionIdentityAuthority,
} from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

const sessionIds = new WeakMap<object, string>();
const sessionIdentity: GrokSessionIdentityAuthority = {
  async load(principal) { return sessionIds.get(principal as object); },
  async bind(principal, sessionId) { sessionIds.set(principal as object, sessionId); },
  resolveSessionFile(principal) {
    const record = principal as { sessionFile?: unknown; sessionDirectory?: unknown };
    if (typeof record.sessionFile === "string" && record.sessionFile.trim() !== "") {
      return record.sessionFile;
    }
    if (typeof record.sessionDirectory === "string" && record.sessionDirectory.trim() !== "") {
      return join(record.sessionDirectory, "session.jsonl");
    }
    return join("/run", "session", "session.jsonl");
  },
};

function turnRequest(input: {
  readonly runDirectory: string;
  readonly home?: string;
  readonly agentDir?: string;
  readonly continuation?: RoleTurnRequest["continuation"];
  readonly activation?: RoleTurnRequest["activation"] | { readonly role: string };
  readonly model?: RoleTurnRequest["model"];
  readonly principal?: RoleTurnRequest["principal"];
}): RoleTurnRequest {
  const sessionDirectory = join(input.runDirectory, "session");
  const sessionFile = join(sessionDirectory, "session.jsonl");
  return {
    principal: input.principal ?? fixturePrincipal(sessionDirectory, sessionFile),
    activation: (input.activation ?? { role: "judge" }) as RoleTurnRequest["activation"],
    methods: [],
    continuation: input.continuation ?? { kind: "initial", prompt: "decide" },
    model: input.model ?? { provider: "xai", model: "grok-4.5" },
    cwd: "/work",
    home: input.home ?? "/home/user",
    agentDir: input.agentDir ?? "/agent",
    runDirectory: input.runDirectory,
  } as RoleTurnRequest;
}

const request = turnRequest({ runDirectory: "/run" });

function prepared(
  closeRound: GrokPreparedTurn["closeRound"],
  mcpServers: Readonly<Record<string, unknown>>[] = [{}],
  materials: readonly unknown[] = [],
  extras: { abortSignal?: AbortSignal } = {},
): GrokPreparedTurn {
  return {
    mcpServers,
    systemPrompt: { body: "law", materials },
    prompt: "decide",
    closeRound,
    ...(extras.abortSignal === undefined ? {} : { abortSignal: extras.abortSignal }),
  };
}

/** Faux prepare helper. */
function prepareWithLayout(
  closeRound: GrokPreparedTurn["closeRound"],
  mcpServers: Readonly<Record<string, unknown>>[] = [{}],
  materials: readonly unknown[] = [],
  extras: { abortSignal?: AbortSignal } = {},
): (request: RoleTurnRequest) => Promise<GrokPreparedTurn> {
  return async () => {
    return prepared(closeRound, mcpServers, materials, extras);
  };
}


function canDenyInitializeMeta() {
  return {
    agentCapabilities: { loadSession: true },
    _meta: {
      modelState: { availableModels: [{ modelId: "grok-4.5" }] },
      "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny"] },
    },
  };
}

test("grok host closes an accepted ACP turn through the typed round boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-accept-"));
  try {
    const localRequest = turnRequest({ runDirectory: join(home, "run"), home, agentDir: join(home, "agent") });
    const calls: Array<[string, unknown]> = [];
    const capabilities: unknown[] = [];
    const connection: GrokAcpConnection = {
      async request(method, params) {
        calls.push([method, params]);
        if (method === "initialize") return canDenyInitializeMeta();
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
      prepare: prepareWithLayout(async () => ({ accepted: true }), [{ name: "ak-role", command: "node", args: ["server.js"] }]),
    });

    assert.deepEqual(await host.executeTurn(localRequest), { code: 0, stderr: "", timedOut: false });
    assert.deepEqual(calls.map(([method]) => method), ["initialize", "session/new", "session/prompt", "session/close"]);
    // Default fixture role is judge: canDeny does not install the Fixer-only seatbelt.
    assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: false }]);
    await assert.rejects(readFile(join(home, "hooks", "ak-bash-seatbelt.json")));
    assert.deepEqual(calls[1], ["session/new", {
      cwd: "/work",
      mcpServers: [{ name: "ak-role", command: "node", args: ["server.js"] }],
      _meta: { systemPromptOverride: "law", yoloMode: false },
    }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("grok host installs PreToolUse deny only for Fixer when the host can deny", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-fixer-deny-"));
  try {
    const localRequest = turnRequest({
      runDirectory: join(home, "run"),
      home,
      agentDir: join(home, "agent"),
      activation: { role: "fixer" },
    });
    const capabilities: unknown[] = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async (_request, declaration) => { capabilities.push(declaration); },
      connect: async () => ({
        async request(method) {
          if (method === "initialize") return canDenyInitializeMeta();
          if (method === "session/new") return { sessionId: "s1" };
          if (method === "session/prompt") return { stopReason: "end_turn" };
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_fixer_output"] }),
      prepare: prepareWithLayout(async () => ({ accepted: true })),
    });
    assert.equal((await host.executeTurn(localRequest)).code, 0);
    assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: true }]);
    // Presence of the hook file is the external hang signal; do not lock matcher text.
    await readFile(join(home, "hooks", "ak-bash-seatbelt.json"), "utf8");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("grok host records preToolUseDeny false when the host cannot deny", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-nodeny-"));
  try {
    const localRequest = turnRequest({
      runDirectory: join(home, "run"),
      home,
      agentDir: join(home, "agent"),
      activation: { role: "fixer" },
    });
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
      inspect: async () => ({ privateActive: [], akActive: ["ak_fixer_output"] }),
      prepare: prepareWithLayout(async () => ({ accepted: true })),
    });
    assert.equal((await host.executeTurn(localRequest)).code, 0);
    assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: false }]);
    await assert.rejects(readFile(join(home, "hooks", "ak-bash-seatbelt.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("grok resume reuses native ACP session via session/load when an ACP binding exists", async () => {
  // Fully mocked ACP binding: pure-memory proof on a fixed virtual path, no host resources.
  {
    const runDirectory = "/run/rebind";
    const sessionCalls: Array<[string, unknown]> = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity: {
        async load() { return "bound-s1"; },
        async bind() {},
        resolveSessionFile: sessionIdentity.resolveSessionFile,
      },
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          sessionCalls.push([method, params]);
          if (method === "session/load") return { sessionId: "bound-s1" };
          return method === "session/prompt" ? { stopReason: "end_turn" } : {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: prepareWithLayout(async () => ({ accepted: true })),
    });

    const result = await host.executeTurn(turnRequest({
      runDirectory,
      continuation: { kind: "resume", prompt: "again" },
    }));
    assert.equal(result.code, 0);
    assert.equal(sessionCalls.some(([m]) => m === "session/load"), true);
    const loaded = sessionCalls.find(([m]) => m === "session/load");
    assert.deepEqual(loaded, ["session/load", {
      sessionId: "bound-s1",
      cwd: "/work",
      mcpServers: [{}],
      _meta: { systemPromptOverride: "law", yoloMode: false },
    }]);
  }
});

test("grok host does not reject a non-xai provider before ACP capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-non-xai-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run"), home: join(root, "home"), agentDir: join(root, "agent") });
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method) {
          if (method === "initialize") return { _meta: { modelState: { availableModels: [{ modelId: "gpt-5.6-sol" }] } } };
          if (method === "session/new") return { sessionId: "s-non-xai" };
          if (method === "session/prompt") return { stopReason: "end_turn" };
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: prepareWithLayout(async () => ({ accepted: true })),
    });

    const result = await host.executeTurn({
      ...local,
      model: { provider: "openai-codex", model: "gpt-5.6-sol" },
    });
    assert.equal(result.knownFailure, undefined);
    assert.equal(result.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("grok host serializes concurrent ACP prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-serial-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
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
      prepare: prepareWithLayout(async () => ({ accepted: true })),
    });

    const first = host.executeTurn(local);
    const second = host.executeTurn(local);
    await firstPromptStarted;
    assert.equal(promptCount, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(promptCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok refusal is a typed failure and cancels instead of closing as accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-refusal-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
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
      prepare: prepareWithLayout(async () => assert.fail("refusal must not close the ledger round")),
    });

    const result = await host.executeTurn(local);
    assert.equal(result.knownFailure?.identity?.code, "refusal");
    assert.equal(calls.includes("session/close"), false);
    assert.equal(calls.includes("session/cancel"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host delivers a typed rejection and resubmits in the same ACP session", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-retry-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
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
      prepare: prepareWithLayout(async () => ++rounds === 1
        ? { accepted: false, retry: { code: "non-sole-round", toolCallIds: ["bad"] } }
        : { accepted: true }),
    });

    assert.equal((await host.executeTurn(local)).code, 0);
    assert.equal(prompts.length, 2);
    assert.equal((prompts[0] as { sessionId: string }).sessionId, "retry-session");
    assert.equal((prompts[1] as { sessionId: string }).sessionId, "retry-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host aborts a hanging session/prompt when prepare abortSignal fires", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-abort-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
    const cancels: unknown[] = [];
    const closes: string[] = [];
    const abort = new AbortController();
    const knownFailure = {
      cause: "output" as const,
      identity: { name: "InfrastructureFailure", code: "role-infrastructure-failure" },
      diagnostic: "engine auth timed out",
    };
    let releasePrompt: (() => void) | undefined;
    const promptHang = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      releasePrompt = () => resolve({ stopReason: "end_turn" });
    });
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method) {
          if (method === "session/new") return { sessionId: "abort-session" };
          if (method === "session/prompt") return promptHang;
          return {};
        },
        notify(method, params) { cancels.push([method, params]); },
        async close() { closes.push("close"); },
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: prepareWithLayout(
        async () => ({ accepted: false, failure: knownFailure }),
        [{}],
        [],
        { abortSignal: abort.signal },
      ),
    });

    const turn = host.executeTurn(local);
    // Let session/prompt start hanging, then fire the envelope abort (infra declaration path).
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort();
    const result = await Promise.race([
      turn,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("#593: abortSignal did not terminate hanging session/prompt")), 1000);
      }),
    ]);
    assert.deepEqual(result, { code: null, stderr: "", timedOut: false, knownFailure });
    assert.deepEqual(cancels, [["session/cancel", { sessionId: "abort-session" }]]);
    assert.deepEqual(closes, ["close"]);
    // Hang resolver must not be required for loud terminal.
    releasePrompt?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host does not send session/prompt when abortSignal is already aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-preabort-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
    const promptCalls: unknown[] = [];
    const knownFailure = {
      cause: "output" as const,
      identity: { name: "InfrastructureFailure", code: "pre-aborted" },
      diagnostic: "already aborted",
    };
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          if (method === "session/new") return { sessionId: "pre-aborted-session" };
          if (method === "session/prompt") {
            promptCalls.push(params);
            return { stopReason: "end_turn" };
          }
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: prepareWithLayout(
        async () => ({ accepted: false, failure: knownFailure }),
        [{}],
        [],
        { abortSignal: AbortSignal.abort() },
      ),
    });

    const result = await host.executeTurn(local);
    assert.deepEqual(result, { code: null, stderr: "", timedOut: false, knownFailure });
    assert.equal(promptCalls.length, 0, "session/prompt must not be sent when already aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host drains late in-flight prompt rejection after abort wins race", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-drain-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
    const abort = new AbortController();
    const knownFailure = {
      cause: "output" as const,
      identity: { name: "InfrastructureFailure", code: "in-flight-aborted" },
      diagnostic: "infra failure",
    };
    let rejectPrompt: ((err: Error) => void) | undefined;
    const promptPromise = new Promise<Readonly<Record<string, unknown>>>((_, reject) => {
      rejectPrompt = reject;
    });
    let promptStarted!: () => void;
    const promptStartedP = new Promise<void>((resolve) => { promptStarted = resolve; });
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method) {
          if (method === "session/new") return { sessionId: "drain-session" };
          if (method === "session/prompt") {
            promptStarted();
            return promptPromise;
          }
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: prepareWithLayout(
        async () => ({ accepted: false, failure: knownFailure }),
        [{}],
        [],
        { abortSignal: abort.signal },
      ),
    });

    const turn = host.executeTurn(local);
    await promptStartedP;
    abort.abort();
    const result = await turn;
    assert.deepEqual(result, { code: null, stderr: "", timedOut: false, knownFailure });
    // Rejecting late after abort won race must be safely drained without unhandled rejection
    rejectPrompt?.(new Error("late ACP socket disconnect"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host reports typed round closure failure instead of accepting no submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-nosub-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
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
      prepare: prepareWithLayout(async () => ({ accepted: false, failure: knownFailure })),
    });
    assert.deepEqual(await host.executeTurn(local), { code: null, stderr: "", timedOut: false, knownFailure });
    assert.deepEqual(cancels, [["session/cancel", { sessionId: "s1" }]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("HEAD-matched calling-repo projectInstructions leave privateActive without becoming AK injection", () => {
  assert.deepEqual(classifyGrokInspection({
    projectInstructions: [
      { path: "/work/CLAUDE.md", scope: "project" },
      { path: "/work/AGENTS.md", scope: "project" },
      { path: "/home/.claude/CLAUDE.md", scope: "global" },
    ],
    skills: [{ name: "ak-method", source: { type: "project", path: "/pkg/resources/method/SKILL.md" } }],
  }, "/pkg", {
    headMatchedProjectInstructionPaths: new Set(["/work/CLAUDE.md", "/work/AGENTS.md"]),
  }), {
    privateActive: ["projectInstructions:/home/.claude/CLAUDE.md"],
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

test("inspect→activation surfaces provenance infrastructure failure without private-config-active", async () => {
  const boom = Object.assign(new Error("project instruction unreadable"), { code: "EACCES" });
  let connected = false;
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
    connect: async () => { connected = true; throw new Error("must not connect"); },
    inspect: async () => { throw boom; },
    prepare: async () => prepared(async () => ({ accepted: true })),
  });
  await assert.rejects(
    () => host.executeTurn(request),
    (error: unknown) => error === boom,
  );
  assert.equal(connected, false);
});

test("grok host enters session/new when inspect akActive is empty but prepared MCP is present", async () => {
  // External packageRoot is injected at prepare, not via Grok-native inspect paths.
  const root = await mkdtemp(join(tmpdir(), "ak-grok-external-mcp-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
    const methods: string[] = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method) {
          methods.push(method);
          if (method === "initialize") return canDenyInitializeMeta();
          if (method === "session/new") return { sessionId: "s-external" };
          if (method === "session/prompt") return { stopReason: "end_turn" };
          if (method === "session/close") return {};
          throw new Error(method);
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: [] }),
      prepare: prepareWithLayout(
        async () => ({ accepted: true }),
        [{ name: "ak-judge", command: "node", args: ["relay.js"] }],
      ),
    });
    assert.deepEqual(await host.executeTurn(local), { code: 0, stderr: "", timedOut: false });
    assert.equal(methods.includes("session/new"), true);
    assert.equal(methods.includes("session/prompt"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host rejects ak-config-missing only when prepared MCP servers are absent", async () => {
  let connected = false;
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
    connect: async () => { connected = true; throw new Error("must not connect"); },
    inspect: async () => ({ privateActive: [], akActive: ["stale-inspect-only"] }),
    prepare: async () => prepared(async () => ({ accepted: true }), []),
  });
  assert.deepEqual(await host.executeTurn(request), {
    code: null, stderr: "", timedOut: false,
    knownFailure: {
      cause: "activation",
      identity: { name: "UncontrolledGrokSession", code: "ak-config-missing" },
    },
  });
  assert.equal(connected, false);
});

test("grok host keeps session/close failure loud after typed round acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-close-boom-"));
  try {
    const local = turnRequest({ runDirectory: join(root, "run") });
    const connection: GrokAcpConnection = {
      async request(method) {
        if (method === "initialize") return canDenyInitializeMeta();
        if (method === "session/new") return { sessionId: "s-close-boom" };
        if (method === "session/prompt") return { stopReason: "end_turn" };
        if (method === "session/close") {
          throw Object.assign(new Error("unexpected close fault"), { code: "acp-permission-missing-allow-once" });
        }
        throw new Error(method);
      },
      notify() {},
      async close() {},
    };
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => connection,
      inspect: async () => ({ privateActive: [], akActive: [] }),
      prepare: prepareWithLayout(async () => ({ accepted: true }), [{}]),
    });
    await assert.rejects(
      () => host.executeTurn(local),
      (error: unknown) =>
        error instanceof Error
        && error.message === "unexpected close fault"
        && (error as { code?: unknown }).code === "acp-permission-missing-allow-once",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
