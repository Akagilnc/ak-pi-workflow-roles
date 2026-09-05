import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  connectGrokAcpStdio,
  controlledGrokChildEnv,
  createGrokRoleTurnHost,
  inspectControlledGrok,
  prepareControlledGrokHome,
} from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

test("controlled Grok inspect keeps auth but excludes personalized sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-inspect-"));
  try {
    const sourceHome = join(root, "personalized");
    const controlledHome = join(root, "controlled");
    await mkdir(join(sourceHome, ".grok"), { recursive: true });
    await writeFile(join(sourceHome, ".grok", "auth.json"), "AUTHORITY", { mode: 0o600 });
    const executable = join(root, "grok-faux.mjs");
    await writeFile(executable, `#!/usr/bin/env node
const privateSource = process.env.HOME.includes("personalized");
process.stdout.write(JSON.stringify({
  skills: privateSource ? [{ name: "private", source: { type: "user", path: process.env.HOME + "/.grok/skills/private/SKILL.md" } }] : [{ name: "ak", source: { type: "project", path: process.env.AK_PACKAGE_ROOT + "/souls/judge.md" } }],
  plugins: privateSource ? [{ name: "private-plugin", enabled: true, path: process.env.HOME + "/plugin" }] : [],
  agents: [{ name: "builtin", source: { type: "builtin" } }]
}));
`);
    await chmod(executable, 0o755);
    await prepareControlledGrokHome(sourceHome, controlledHome);
    assert.equal(await readFile(join(controlledHome, "auth.json"), "utf8"), "AUTHORITY");
    const env = controlledGrokChildEnv({ ...process.env, AK_PACKAGE_ROOT: "/pkg" }, controlledHome);
    assert.deepEqual(await inspectControlledGrok({ binary: executable, cwd: root, env, packageRoot: "/pkg" }), {
      privateActive: [], akActive: ["skills:ak"],
    });
  } finally {
  }
});

test("ACP stdio preserves spawn failure and rejects later writes", async () => {
  const connection = await connectGrokAcpStdio({ binary: join(tmpdir(), "missing-grok-binary"), cwd: tmpdir(), env: process.env });
  await assert.rejects(connection.request("initialize", {}), (error: Error & { code?: string }) => error.code === "acp-process-error");
  await assert.rejects(connection.request("after-error", {}), (error: Error & { code?: string }) => error.code === "acp-process-error");
  assert.throws(() => connection.notify("after-error", {}), (error: Error & { code?: string }) => error.code === "acp-process-error");
  await connection.close();
});

test("malformed ACP frame terminates the connection and settles every pending request", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-acp-malformed-"));
  try {
    const executable = join(root, "grok-malformed.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
let requests = 0;
createInterface({ input: process.stdin }).on("line", () => {
  if (++requests === 2) process.stdout.write("not-json\\n");
});
process.on("SIGTERM", () => process.exit(0));
`);
    await chmod(executable, 0o755);
    const connection = await connectGrokAcpStdio({ binary: executable, cwd: root, env: process.env });
    const first = connection.request("first", {});
    const second = connection.request("second", {});
    const typed = (error: Error & { code?: string }) => error.code === "acp-invalid-json";
    await assert.rejects(first, typed);
    await assert.rejects(second, typed);
    await assert.rejects(connection.request("after-malformed", {}), typed);
  } finally {
  }
});

test("ACP stdio answers host permission requests through the typed protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-acp-permission-"));
  try {
    const executable = join(root, "grok-permission.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 90, method: "session/request_permission", params: { options: [{ optionId: "once", kind: "allow_once" }] } }) + "\\n");
  } else if (message.id === 90) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: message.result }) + "\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
`);
    await chmod(executable, 0o755);
    const connection = await connectGrokAcpStdio({ binary: executable, cwd: root, env: process.env });
    assert.deepEqual(await connection.request("initialize", {}), { outcome: { outcome: "selected", optionId: "once" } });
    await connection.close();
  } finally {
  }
});

test("ACP stdio pairs framed replies and closes one real child", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-grok-acp-faux-"));
  try {
    const executable = join(root, "grok-faux.mjs");
    const events = join(root, "events.jsonl");
    const launch = join(root, "launch.json");
    await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const events = process.env.FAUX_EVENTS;
writeFileSync(process.env.FAUX_LAUNCH, JSON.stringify({ args: process.argv.slice(2), config: process.env.GROK_CONFIG }));
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
  const connection = await connectGrokAcpStdio({
    binary: executable,
    cwd: root,
    env: { ...process.env, FAUX_EVENTS: events, FAUX_LAUNCH: launch },
    model: "grok-4.5",
    toolset: "coding",
  });
  const [first, second] = await Promise.all([
    connection.request("first", { order: 1 }),
    connection.request("second", { order: 2 }),
  ]);
  assert.deepEqual(first, { order: 1 });
  assert.deepEqual(second, { order: 2 });
  connection.notify("session/cancel", { sessionId: "s1" });
  await connection.close();
    assert.deepEqual((await readFile(events, "utf8")).trim().split("\n").map((line) => JSON.parse(line).method), ["first", "second", "session/cancel"]);
    assert.deepEqual(JSON.parse(await readFile(launch, "utf8")), {
      args: ["agent", "--model", "grok-4.5", "stdio"],
      config: JSON.stringify({ toolset: "coding" }),
    });
    await assert.rejects(connection.request("after-close", {}), (error: Error & { code?: string }) => error.code === "acp-connection-closed");
    assert.throws(() => connection.notify("after-close", {}), (error: Error & { code?: string }) => error.code === "acp-connection-closed");
  } finally {
  }
});

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
  }
});

test("executeTurn resume after settle scrubs residual AK seatbelt hooks", async () => {
  // #594 F1: residual AK hooks under controlled home must not survive settle into the
  // next executeTurn. Inspect goes through real inspectControlledGrok → classifyGrokInspection
  // (faux binary reports filesystem hooks the way grok inspect does — source.type=user).
  const root = await mkdtemp(join(tmpdir(), "ak-grok-resume-hooks-"));
  const home = join(root, "controlled");
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

    const sessionIds = new WeakMap<object, string>();
    const host = createGrokRoleTurnHost({
      sessionIdentity: {
        async load(p: object) { return sessionIds.get(p); },
        async bind(p: object, sessionId: string) { sessionIds.set(p, sessionId); },
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
      },
      recordCapabilities: async () => {},
      connect: async () => ({
        async request(method) {
          if (method === "initialize") {
            return {
              agentCapabilities: { loadSession: true },
              _meta: {
                modelState: { availableModels: [{ modelId: "grok-4.5" }] },
                "x.ai/hooks": { blockingEvents: ["pre_tool_use"], decisions: ["deny"] },
              },
            };
          }
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
      prepare: async () => ({
        mcpServers: [{}],
        systemPrompt: { body: "law", materials: [] },
        prompt: "decide",
        closeRound: async () => ({ accepted: true }),
      }),
    });

    const runDirectory = join(home, "run");
    const sessionDirectory = join(runDirectory, "session");
    const localRequest = {
      principal: fixturePrincipal(sessionDirectory, join(sessionDirectory, "session.jsonl")),
      activation: { role: "fixer" } as RoleTurnRequest["activation"],
      methods: [],
      continuation: { kind: "initial", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" },
      cwd: root,
      home,
      agentDir: join(home, "agent"),
      runDirectory,
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
  } finally {
  }
});
