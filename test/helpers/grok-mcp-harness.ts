/**
 * Shared MCP JSON-line face for Grok envelope integration tests.
 * Single owner: do not re-implement call/list in individual test files.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type GrokMcpServer = {
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export async function listThroughMcp(server: GrokMcpServer): Promise<Record<string, unknown>> {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    const response = JSON.parse(line.value) as { result?: Record<string, unknown>; error?: unknown };
    assert.equal(response.error, undefined);
    return response.result ?? {};
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

export async function callThroughMcp(
  server: GrokMcpServer,
  name: string,
  args: unknown,
): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    return JSON.parse(line.value) as { result?: Record<string, unknown>; error?: unknown };
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}
