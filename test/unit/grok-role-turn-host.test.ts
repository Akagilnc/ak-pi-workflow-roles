import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyGrokInspection, connectGrokAcpStdio, controlledGrokChildEnv, createGrokRoleTurnHost, type GrokAcpConnection } from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";

const request = {
  principal: {}, activation: { role: "judge" }, methods: [],
  continuation: { kind: "initial", prompt: "decide" },
  model: { provider: "xai", model: "grok-build" }, cwd: "/work", home: "/home/user",
  agentDir: "/agent", runDirectory: "/run",
} as RoleTurnRequest;

test("ACP stdio pairs framed replies and closes one real child", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-acp-faux-"));
  const executable = join(root, "grok-faux.mjs");
  const events = join(root, "events.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const events = process.env.FAUX_EVENTS;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(events, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.id === undefined) return;
  const delay = message.params.order === 1 ? 15 : 0;
  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { order: message.params.order } }) + "\\n"), delay);
});
process.on("SIGTERM", () => process.exit(0));
`);
  await chmod(executable, 0o755);
  const connection = await connectGrokAcpStdio({ binary: executable, cwd: root, env: { ...process.env, FAUX_EVENTS: events } });
  const [first, second] = await Promise.all([
    connection.request("first", { order: 1 }),
    connection.request("second", { order: 2 }),
  ]);
  assert.deepEqual(first, { order: 1 });
  assert.deepEqual(second, { order: 2 });
  connection.notify("session/cancel", { sessionId: "s1" });
  await connection.close();
  assert.deepEqual((await readFile(events, "utf8")).trim().split("\n").map((line) => JSON.parse(line).method), ["first", "second", "session/cancel"]);
});

test("grok host closes an accepted ACP turn through the typed round boundary", async () => {
  const calls: Array<[string, unknown]> = [];
  const connection: GrokAcpConnection = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === "initialize") return { agentCapabilities: { loadSession: true } };
      if (method === "session/new") return { sessionId: "s1" };
      if (method === "session/prompt") return { stopReason: "end_turn" };
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
  assert.deepEqual(calls.map(([method]) => method), ["initialize", "session/new", "session/prompt", "session/cancel"]);
  assert.deepEqual(calls[1], ["session/new", { cwd: "/work", mcpServers: [{ name: "ak-role", command: "node", args: ["server.js"] }], _meta: { systemPromptOverride: "law" } }]);
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
