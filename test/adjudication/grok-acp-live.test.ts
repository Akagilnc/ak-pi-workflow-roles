import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import { connectGrokAcpStdio, controlledGrokChildEnv, prepareControlledGrokHome, type GrokAcpConnection } from "../../src/grok/role-turn-host.ts";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

const binary = join(homedir(), ".grok", "bin", "grok");
const auth = join(homedir(), ".grok", "auth.json");

/** Bare live seam: ACP resume/runtime controls cannot be credibly simulated. */
test("real Grok 1.0.13 exposes typed G8/G9/G11/G12", { timeout: 240_000 }, async (t) => {
  try { await Promise.all([access(binary), access(auth)]); } catch { t.skip("authenticated Grok unavailable"); return; }
  await withTempRoot("ak-grok-acp-live-", async (home) => {
  const connections: GrokAcpConnection[] = [];
  const open = async (options: { toolset?: string; onNotification?: (method: string, params: Readonly<Record<string, unknown>>) => void } = {}) => {
    const connection = await connectGrokAcpStdio({
      binary, cwd: process.cwd(), env: controlledGrokChildEnv(process.env, home),
      ...(options.toolset === undefined ? {} : { toolset: options.toolset }),
      ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    });
    connections.push(connection);
    await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    return connection;
  };
    return withPrimaryAwareCleanup(
      async () => {

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

    // G12: session/load must replay non-empty history, not merely return the same id.
    const replayed: string[] = [];
    const resumed = await open({
      onNotification(method, params) {
        if (method !== "session/update") return;
        const update = (params as { update?: unknown }).update;
        if (typeof update === "object" && update !== null && typeof (update as { sessionUpdate?: unknown }).sessionUpdate === "string") {
          replayed.push((update as { sessionUpdate: string }).sessionUpdate);
        }
      },
    });
    const loaded = await resumed.request("session/load", { sessionId, cwd: process.cwd(), mcpServers: [] });
    assert.equal((loaded._meta as { "x.ai/sessionDetail"?: { sessionId?: unknown } })["x.ai/sessionDetail"]?.sessionId, sessionId);
    assert.ok(
      replayed.some((kind) => kind === "user_message_chunk" || kind === "agent_message_chunk"),
      "session/load must replay prior user/assistant history",
    );
    await resumed.request("session/close", { sessionId });
    await resumed.close();

    // G11: GROK_CONFIG toolset=coding must surface the structured coding toolset,
    // and the executed shell tool must report typed rawOutput — not just any
    // completed tool_call_update.
    const observedTools: string[] = [];
    const toolCalls: Array<{ rawOutput?: { type?: unknown } }> = [];
    const configured = await connectGrokAcpStdio({
      binary, cwd: process.cwd(), env: controlledGrokChildEnv(process.env, home), toolset: "coding",
      onNotification(method, params) {
        if (method !== "session/update") return;
        const update = (params as { update?: unknown }).update;
        if (typeof update !== "object" || update === null) return;
        const record = update as Record<string, unknown>;
        if (record.sessionUpdate === "available_commands_update") {
          const tools = (record._meta as { tools?: unknown } | undefined)?.tools;
          if (Array.isArray(tools)) for (const tool of tools) if (typeof tool === "string") observedTools.push(tool);
        } else if (record.sessionUpdate === "tool_call_update" && record.status === "completed") {
          toolCalls.push(record as unknown as { rawOutput?: { type?: unknown } });
        }
      },
    });
    connections.push(configured);
    await configured.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const configuredSession = await configured.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const configuredId = configuredSession.sessionId as string;
    await configured.request("session/prompt", { sessionId: configuredId, prompt: [{ type: "text", text: "Run pwd with the shell tool exactly once, then stop." }] });
    assert.ok(observedTools.includes("run_terminal_command"), "coding toolset must expose the typed shell tool");
    assert.ok(toolCalls.some((call) => call.rawOutput?.type === "Bash"), "the executed shell tool must report typed Bash rawOutput");
    await configured.request("session/close", { sessionId: configuredId });
    await configured.close();
        },
      async () => { await Promise.allSettled(connections.map((connection) => connection.close())); }
    );
  });
});
