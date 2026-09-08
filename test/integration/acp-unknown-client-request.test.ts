/**
 * #760: unknown ACP client requests must not kill the leg.
 * Seam: connectAcpStdio — real stdio JSON-RPC framing with one scripted agent child.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectAcpStdio } from "../../src/acp-host/role-turn-host.ts";

test("unknown ACP client request gets JSON-RPC method-not-found and the connection stays live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ak-acp-unknown-"));
  const agentPath = join(dir, "fake-acp-agent.mjs");
  const framesPath = join(dir, "stdin-frames.jsonl");

  // One scripted agent: after initialize, emit a vendor client request; record
  // every host→agent frame; answer a later session/prompt so liveness is visible.
  const agentScript = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const framesPath = process.env.AK_FRAMES_PATH;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  appendFileSync(framesPath, line + "\\n");
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.method !== "string" || typeof msg.id !== "number") return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "_x.ai/exit_plan_mode", params: {} }) + "\\n");
    return;
  }
  if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
  }
});
`;

  try {
    await writeFile(agentPath, agentScript, "utf8");
    const connection = await connectAcpStdio({
      binary: process.execPath,
      args: [agentPath],
      cwd: dir,
      env: { ...process.env, AK_FRAMES_PATH: framesPath },
    });
    try {
      const initialized = await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      assert.equal(initialized.protocolVersion, 1);

      // One event-loop turn so the reader handles the vendor client request that
      // arrived on the same stdout burst as the initialize result.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const prompt = await connection.request("session/prompt", {
        sessionId: "s1",
        prompt: [{ type: "text", text: "continue" }],
      });
      assert.equal(prompt.stopReason, "end_turn");
    } finally {
      try { await connection.close(); } catch { /* child may already be gone */ }
    }

    const framesRaw = await readFile(framesPath, "utf8");
    const frames = framesRaw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as {
        id?: unknown;
        error?: { code?: unknown; message?: unknown };
        method?: unknown;
      });

    const methodNotFound = frames.find(
      (frame) => frame.id === 9001 && frame.error !== undefined,
    );
    assert.ok(methodNotFound, `expected error reply for id 9001, frames=${framesRaw}`);
    assert.equal(methodNotFound.error?.code, -32601);
    assert.equal(typeof methodNotFound.error?.message, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
