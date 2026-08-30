import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectGrokAcpStdio, controlledGrokChildEnv, inspectControlledGrok, prepareControlledGrokHome } from "../../src/grok/role-turn-host.ts";

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
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP stdio preserves spawn failure and rejects later writes", async () => {
  const connection = await connectGrokAcpStdio({ binary: join(tmpdir(), "missing-grok-binary"), cwd: tmpdir(), env: process.env });
  await assert.rejects(connection.request("initialize", {}), /process error.*ENOENT/i);
  await assert.rejects(connection.request("after-error", {}), /process error.*ENOENT/i);
  assert.throws(() => connection.notify("after-error", {}), /process error.*ENOENT/i);
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
    await assert.rejects(first, /Invalid Grok ACP JSON/);
    await assert.rejects(second, /Invalid Grok ACP JSON/);
    await assert.rejects(connection.request("after-malformed", {}), /Invalid Grok ACP JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await assert.rejects(connection.request("after-close", {}), /closed/i);
    assert.throws(() => connection.notify("after-close", {}), /closed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
