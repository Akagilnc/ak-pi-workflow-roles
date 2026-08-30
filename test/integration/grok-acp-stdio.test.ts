import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectGrokAcpStdio } from "../../src/grok/role-turn-host.ts";

test("ACP stdio preserves spawn failure and rejects later writes", async () => {
  const connection = await connectGrokAcpStdio({ binary: join(tmpdir(), "missing-grok-binary"), cwd: tmpdir(), env: process.env });
  await assert.rejects(connection.request("initialize", {}), /process error.*ENOENT/i);
  await assert.rejects(connection.request("after-error", {}), /process error.*ENOENT/i);
  assert.throws(() => connection.notify("after-error", {}), /process error.*ENOENT/i);
  await connection.close();
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
    tools: ["read", "bash"],
    deny: ["Shell(rm:*)", "Shell(git clean:*)"],
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
      args: ["agent", "--model", "grok-4.5", "--tools", "read,bash", "--deny", "Shell(rm:*)", "--deny", "Shell(git clean:*)", "--always-approve", "stdio"],
      config: JSON.stringify({ toolset: "coding" }),
    });
    await assert.rejects(connection.request("after-close", {}), /closed/i);
    assert.throws(() => connection.notify("after-close", {}), /closed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
