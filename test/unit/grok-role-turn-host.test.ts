import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FIXER_BASH_FORBIDDEN_LITERALS,
  fixerBashSeatbeltDenyReason,
} from "../../src/fixer-bash-seatbelt.ts";
import { installGrokPreToolUseDeny } from "../../src/grok/bash-seatbelt.ts";
import {
  NO_PRODUCTION_GROK_PRIMARY_FAILURE,
  settleProductionGrokHomeCleanup,
} from "../../src/grok/production-host.ts";
import {
  classifyGrokInspection,
  controlledGrokChildEnv,
  createGrokRoleTurnHost,
  formatGrokRebuildHistoryContext,
  inspectControlledGrok,
  projectGrokRebuildHistory,
  type GrokAcpConnection,
  type GrokPreparedTurn,
} from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

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

async function runInstalledSeatbeltHook(
  home: string,
  command: string,
): Promise<{ decision: string; reason?: string }> {
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
      toolInput: { command },
    }));
  });
  return JSON.parse(stdout) as { decision: string; reason?: string };
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
    const localRequest = { ...request, home, agentDir: join(home, "agent"), runDirectory: join(home, "run") } as RoleTurnRequest;
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
      prepare: async () => prepared(async () => ({ accepted: true }), [{ name: "ak-role", command: "node", args: ["server.js"] }]),
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
    const localRequest = {
      ...request,
      activation: { role: "fixer" },
      home,
      agentDir: join(home, "agent"),
      runDirectory: join(home, "run"),
    } as RoleTurnRequest;
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
      prepare: async () => prepared(async () => ({ accepted: true })),
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
    const localRequest = {
      ...request,
      activation: { role: "fixer" },
      home,
      agentDir: join(home, "agent"),
      runDirectory: join(home, "run"),
    } as RoleTurnRequest;
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
      prepare: async () => prepared(async () => ({ accepted: true })),
    });
    assert.equal((await host.executeTurn(localRequest)).code, 0);
    assert.deepEqual(capabilities, [{ nativeToolNarrowing: false, preToolUseDeny: false }]);
    await assert.rejects(readFile(join(home, "hooks", "ak-bash-seatbelt.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("installed seatbelt hook denies the representative dangerous command and all four ADR literals", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-seatbelt-hook-"));
  try {
    await installGrokPreToolUseDeny(home);
    assert.deepEqual(await runInstalledSeatbeltHook(home, "rm -rf /tmp/danger"), {
      decision: "deny",
      reason: fixerBashSeatbeltDenyReason("rm -rf"),
    });
    assert.deepEqual(await runInstalledSeatbeltHook(home, "ls -la"), { decision: "allow" });
    for (const literal of FIXER_BASH_FORBIDDEN_LITERALS) {
      assert.deepEqual(
        await runInstalledSeatbeltHook(home, `prefix ${literal} suffix`),
        { decision: "deny", reason: fixerBashSeatbeltDenyReason(literal) },
        literal,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("executeTurn resume rebuilds via session/new after settle scrubs residual AK seatbelt hooks", async () => {
  // #594 F1: residual AK hooks under controlled home must not survive settle into the
  // next executeTurn. Inspect goes through real inspectControlledGrok → classifyGrokInspection
  // (faux binary reports filesystem hooks the way grok inspect does — source.type=user).
  const root = await mkdtemp(join(tmpdir(), "ak-grok-resume-hooks-"));
  const home = join(root, "controlled");
  const principal = {};
  try {
    await mkdir(home, { recursive: true });
    const binary = join(root, "grok-inspect-faux.mjs");
    await writeFile(binary, `#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join } from "node:path";
const home = process.env.GROK_HOME ?? process.env.HOME ?? "";
const hookPath = join(home, "hooks", "ak-bash-seatbelt.json");
let hooks = [];
try {
  await access(hookPath);
  hooks = [{ name: "ak-bash-seatbelt", source: { type: "user", path: hookPath } }];
} catch { /* absent → empty hooks, as a clean controlled home */ }
process.stdout.write(JSON.stringify({
  hooks, skills: [], agents: [], plugins: [], mcpServers: [], projectInstructions: [],
}));
`);
    await chmod(binary, 0o755);

    await installGrokPreToolUseDeny(home);
    const inspectEnv = controlledGrokChildEnv({ ...process.env }, home);
    // Pre-settle: real classify path sees residual hook as privateActive (red without scrub).
    const beforeSettle = await inspectControlledGrok({
      binary, cwd: root, env: inspectEnv, packageRoot,
    });
    assert.deepEqual(beforeSettle.privateActive, ["hooks:ak-bash-seatbelt"]);

    await settleProductionGrokHomeCleanup(
      home,
      NO_PRODUCTION_GROK_PRIMARY_FAILURE,
      "test settle after residual hooks",
    );
    // Post-settle: same inspect seam reports empty privateActive.
    const afterSettle = await inspectControlledGrok({
      binary, cwd: root, env: inspectEnv, packageRoot,
    });
    assert.deepEqual(afterSettle.privateActive, []);

    const sessionCalls: Array<[string, unknown]> = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity: {
        async load(p: object) { return sessionIds.get(p); },
        async bind(p: object, sessionId: string) { sessionIds.set(p, sessionId); },
      },
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          sessionCalls.push([method, params]);
          if (method === "initialize") return canDenyInitializeMeta();
          if (method === "session/new") return { sessionId: "resume-s1" };
          if (method === "session/load") return { sessionId: "resume-s1" };
          if (method === "session/prompt") return { stopReason: "end_turn" };
          return {};
        },
        notify() {},
        async close() {},
      }),
      // Production inspect seam: inspectControlledGrok + classifyGrokInspection.
      inspect: async (req) => inspectControlledGrok({
        binary,
        cwd: req.cwd === "/work" ? root : req.cwd,
        env: controlledGrokChildEnv({ ...process.env }, req.home),
        packageRoot,
      }),
      prepare: async () => prepared(async () => ({ accepted: true })),
    });

    const localRequest = {
      ...request,
      principal,
      activation: { role: "fixer" },
      home,
      cwd: root,
      agentDir: join(home, "agent"),
      runDirectory: join(home, "run"),
    } as RoleTurnRequest;

    assert.equal((await host.executeTurn(localRequest)).code, 0);
    // Fixer install re-writes hooks during the turn; settle again before resume.
    await settleProductionGrokHomeCleanup(
      home,
      NO_PRODUCTION_GROK_PRIMARY_FAILURE,
      "test settle before resume",
    );
    const resumeResult = await host.executeTurn({
      ...localRequest,
      continuation: { kind: "resume", prompt: "continue after 429" },
    });
    assert.equal(resumeResult.code, 0);
    assert.equal(resumeResult.knownFailure, undefined);
    // #617: resume never session/load — JSONL rebuild via session/new + rebind.
    assert.equal(sessionCalls.some(([method]) => method === "session/load"), false);
    const resumeOpen = sessionCalls.filter(([method]) => method === "session/new");
    assert.ok(resumeOpen.length >= 2, "initial + resume must both session/new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok resume always session/new and rebinds even when an ACP binding exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-rebind-"));
  try {
    const runDirectory = join(root, "run");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const principal = {};
    const bound: string[] = [];
    const sessionCalls: Array<[string, unknown]> = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity: {
        async load() { return "stale-binding-id"; },
        async bind(_p, sessionId) { bound.push(sessionId); },
      },
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          sessionCalls.push([method, params]);
          if (method === "session/new") return { sessionId: "fresh-s1" };
          if (method === "session/load") return { sessionId: "should-not-load" };
          return method === "session/prompt" ? { stopReason: "end_turn" } : {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => prepared(async () => ({ accepted: true })),
    });

    const result = await host.executeTurn({
      ...request,
      principal,
      runDirectory,
      continuation: { kind: "resume", prompt: "again" },
    } as RoleTurnRequest);
    assert.equal(result.code, 0);
    assert.equal(sessionCalls.some(([m]) => m === "session/load"), false);
    const opened = sessionCalls.find(([m]) => m === "session/new");
    assert.equal(opened?.[0], "session/new");
    assert.deepEqual(bound, ["fresh-s1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * #617 DK-1: resume projects full structured JSONL history (user/assistant text +
 * toolCall.arguments + toolResult.details) into ACP embeddedContext — never text-only.
 * Fixture is a real Pi-shaped escalate→resume chain (frozen 471 volume).
 */
test("resume rebuilds Pi-shaped toolCall/toolResult history into the ACP prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-jsonl-rebuild-"));
  try {
    const fixtureSession = join(
      packageRoot,
      "test/fixtures/471-resume-chain/01a03c71-4710-7000-8000-escalate-resume01@judge/session/session.jsonl",
    );
    const prior = await readFile(fixtureSession, "utf8");
    const projected = projectGrokRebuildHistory(prior);
    const toolCalls = projected.filter((t) => t.kind === "toolCall");
    const toolResults = projected.filter((t) => t.kind === "toolResult");
    assert.ok(toolCalls.length >= 2, "fixture must retain assistant toolCall leaves");
    assert.ok(toolResults.length >= 2, "fixture must retain paired toolResult leaves");
    const escalateCall = toolCalls.find(
      (t) => t.kind === "toolCall" && t.name === "ak_judge_output"
        && typeof t.arguments === "object" && t.arguments !== null
        && (t.arguments as { judgeStatus?: unknown }).judgeStatus === "escalate",
    );
    assert.ok(escalateCall, "toolCall.arguments must keep judgeStatus=escalate");
    const escalateResult = toolResults.find(
      (t) => t.kind === "toolResult" && t.toolName === "ak_judge_output"
        && typeof t.details === "object" && t.details !== null
        && (t.details as { judgeStatus?: unknown }).judgeStatus === "escalate",
    );
    assert.ok(escalateResult, "toolResult.details must keep judgeStatus=escalate");
    assert.equal(
      escalateResult && escalateCall && escalateResult.toolCallId === escalateCall.id,
      true,
      "toolResult must pair to its toolCall id",
    );

    const runDirectory = join(root, "run");
    const sessionDir = join(runDirectory, "session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.jsonl"), prior, "utf8");

    const prompts: unknown[] = [];
    const bound: string[] = [];
    const host = createGrokRoleTurnHost({
      sessionIdentity: {
        async load() { return "old-binding"; },
        async bind(_p, id) { bound.push(id); },
      },
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method, params) {
          if (method === "initialize") return {};
          if (method === "session/new") return { sessionId: "rebuilt-from-jsonl" };
          if (method === "session/load") return { sessionId: "must-not-load" };
          if (method === "session/prompt") {
            prompts.push(params);
            return { stopReason: "end_turn" };
          }
          return {};
        },
        notify() {},
        async close() {},
      }),
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => ({
        ...prepared(async () => ({ accepted: true })),
        prompt: "continue-now",
      }),
    });

    const result = await host.executeTurn({
      ...request,
      runDirectory,
      continuation: { kind: "resume", prompt: "continue-now" },
    } as RoleTurnRequest);
    assert.equal(result.code, 0);
    assert.deepEqual(bound, ["rebuilt-from-jsonl"]);
    assert.equal(prompts.length, 1);
    const promptParams = prompts[0] as { prompt?: unknown[] };
    const parts = promptParams.prompt ?? [];
    const textPart = parts.find((p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text") as
      | { text?: string }
      | undefined;
    const resourcePart = parts.find((p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "resource") as
      | { resource?: { text?: string; uri?: string } }
      | undefined;
    assert.equal(textPart?.text, "continue-now");
    assert.equal(resourcePart?.resource?.uri, "context://ak-role/session-history");
    // Host delivers the same projector output — structured fields, not text-only.
    assert.equal(resourcePart?.resource?.text, formatGrokRebuildHistoryContext(projected));
    assert.equal(
      resourcePart?.resource?.text?.includes(JSON.stringify(escalateCall!.arguments)),
      true,
    );
    assert.equal(
      resourcePart?.resource?.text?.includes(JSON.stringify(escalateResult!.details)),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok host does not reject a non-xai provider before ACP capabilities", async () => {
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
    prepare: async () => prepared(async () => ({ accepted: true })),
  });

  const result = await host.executeTurn({
    ...request,
    model: { provider: "openai-codex", model: "gpt-5.6-sol" },
  });
  assert.equal(result.knownFailure, undefined);
  assert.equal(result.code, 0);
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

test("grok refusal is a typed failure and cancels instead of closing as accepted", async () => {
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

test("grok host delivers a typed rejection and resubmits in the same ACP session", async () => {
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

test("grok host aborts a hanging session/prompt when prepare abortSignal fires", async () => {
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
    prepare: async () => prepared(
      async () => ({ accepted: false, failure: knownFailure }),
      [{}],
      [],
      { abortSignal: abort.signal },
    ),
  });

  const turn = host.executeTurn(request);
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
});

test("grok host does not send session/prompt when abortSignal is already aborted", async () => {
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
    prepare: async () => prepared(
      async () => ({ accepted: false, failure: knownFailure }),
      [{}],
      [],
      { abortSignal: AbortSignal.abort() },
    ),
  });

  const result = await host.executeTurn(request);
  assert.deepEqual(result, { code: null, stderr: "", timedOut: false, knownFailure });
  assert.equal(promptCalls.length, 0, "session/prompt must not be sent when already aborted");
});

test("grok host drains late in-flight prompt rejection after abort wins race", async () => {
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
  const host = createGrokRoleTurnHost({
    sessionIdentity,
    recordCapabilities: async () => {},
    connect: async () => ({
      async request(method) {
        if (method === "session/new") return { sessionId: "drain-session" };
        if (method === "session/prompt") return promptPromise;
        return {};
      },
      notify() {},
      async close() {},
    }),
    inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
    prepare: async () => prepared(
      async () => ({ accepted: false, failure: knownFailure }),
      [{}],
      [],
      { abortSignal: abort.signal },
    ),
  });

  const turn = host.executeTurn(request);
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  const result = await turn;
  assert.deepEqual(result, { code: null, stderr: "", timedOut: false, knownFailure });
  // Rejecting late after abort won race must be safely drained without unhandled rejection
  rejectPrompt?.(new Error("late ACP socket disconnect"));
});

test("grok host reports typed round closure failure instead of accepting no submission", async () => {
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
    prepare: async () => prepared(
      async () => ({ accepted: true }),
      [{ name: "ak-judge", command: "node", args: ["relay.js"] }],
    ),
  });
  assert.deepEqual(await host.executeTurn(request), { code: 0, stderr: "", timedOut: false });
  assert.equal(methods.includes("session/new"), true);
  assert.equal(methods.includes("session/prompt"), true);
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
    prepare: async () => prepared(async () => ({ accepted: true }), [{}]),
  });
  await assert.rejects(
    () => host.executeTurn(request),
    (error: unknown) =>
      error instanceof Error
      && error.message === "unexpected close fault"
      && (error as { code?: unknown }).code === "acp-permission-missing-allow-once",
  );
});
