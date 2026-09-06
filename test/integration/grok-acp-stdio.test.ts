import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { connectGrokAcpStdio } from "../../src/grok/role-turn-host.ts";

test("ACP stdio preserves spawn failure and rejects later writes", async () => {
  const connection = await connectGrokAcpStdio({ binary: worktreeTempPrefix("missing-grok-binary"), cwd: tmpdir(), env: process.env });
  await assert.rejects(connection.request("initialize", {}), (error: Error & { code?: string }) => error.code === "acp-process-error");
  await assert.rejects(connection.request("after-error", {}), (error: Error & { code?: string }) => error.code === "acp-process-error");
  assert.throws(() => connection.notify("after-error", {}), (error: Error & { code?: string }) => error.code === "acp-process-error");
  await connection.close();
});

test("malformed ACP frame terminates the connection and settles every pending request", async () => {
  await withTempRoot("ak-grok-acp-malformed-", async (root) => {
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
    });
});

test("ACP stdio answers host permission requests through the typed protocol", async () => {
  await withTempRoot("ak-grok-acp-permission-", async (root) => {
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
    });
});

test("ACP stdio pairs framed replies and closes one real child", async () => {
  await withTempRoot("ak-grok-acp-faux-", async (root) => {
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
    });
});
