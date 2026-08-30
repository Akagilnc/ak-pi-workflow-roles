import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectGrokAcpStdio, controlledGrokChildEnv, prepareControlledGrokHome, type GrokAcpConnection } from "../../src/grok/role-turn-host.ts";

const binary = join(homedir(), ".grok", "bin", "grok");
const auth = join(homedir(), ".grok", "auth.json");

/** Bare live seam: ACP resume/runtime controls cannot be credibly simulated. */
test("real Grok 1.0.13 exposes typed G8/G9/G11/G12", { timeout: 180_000 }, async (t) => {
  try { await Promise.all([access(binary), access(auth)]); } catch { t.skip("authenticated Grok unavailable"); return; }
  const home = await mkdtemp(join(tmpdir(), "ak-grok-acp-live-"));
  const connections: GrokAcpConnection[] = [];
  const open = async (options: { toolset?: string } = {}) => {
    const connection = await connectGrokAcpStdio({
      binary, cwd: process.cwd(), env: controlledGrokChildEnv(process.env, home),
      ...(options.toolset === undefined ? {} : { toolset: options.toolset }),
    });
    connections.push(connection);
    await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    return connection;
  };
  try {
    await prepareControlledGrokHome(homedir(), home);
    const firstConnection = await open();
    const session = await firstConnection.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { yoloMode: false } });
    const sessionId = session.sessionId as string;
    assert.ok(sessionId);
    const first = await firstConnection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Do not use tools. Reply READY." }] });
    assert.equal(first.stopReason, "end_turn"); // G8
    const second = await firstConnection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply AGAIN." }] });
    assert.equal((second._meta as { sessionId?: unknown }).sessionId, sessionId); // G9
    await firstConnection.request("session/close", { sessionId });
    await firstConnection.close();

    const resumed = await open();
    const loaded = await resumed.request("session/load", { sessionId, cwd: process.cwd(), mcpServers: [] });
    assert.equal((loaded._meta as { "x.ai/sessionDetail"?: { sessionId?: unknown } })["x.ai/sessionDetail"]?.sessionId, sessionId); // G12
    await resumed.request("session/close", { sessionId });
    await resumed.close();

    const configuredUpdates: Array<{ sessionUpdate?: unknown; status?: unknown }> = [];
    const configured = await connectGrokAcpStdio({
      binary, cwd: process.cwd(), env: controlledGrokChildEnv(process.env, home), toolset: "coding",
      onNotification(method, params) {
        if (method === "session/update" && typeof params.update === "object" && params.update !== null) {
          configuredUpdates.push(params.update as { sessionUpdate?: unknown; status?: unknown });
        }
      },
    });
    connections.push(configured);
    await configured.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const configuredSession = await configured.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const configuredId = configuredSession.sessionId as string;
    await configured.request("session/prompt", { sessionId: configuredId, prompt: [{ type: "text", text: "Run pwd with the shell tool exactly once, then stop." }] });
    assert.equal(configuredUpdates.some(({ sessionUpdate, status }) => sessionUpdate === "tool_call_update" && status === "completed"), true); // G11
    await configured.request("session/close", { sessionId: configuredId });
    await configured.close();
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
