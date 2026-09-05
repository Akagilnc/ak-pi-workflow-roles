import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { packageRoot } from "../helpers/pi-test-harness.ts";
import { testTmpdir } from "../helpers/worktree-temp.ts";

const relayPath = join(packageRoot, "src/grok/mcp-relay.mjs");

type UpstreamHandler = (message: { id: number; method: string; params?: unknown }, socket: Socket) => void;

async function withRelay(
  handleUpstream: UpstreamHandler,
  run: (child: ReturnType<typeof spawn>, replies: AsyncIterator<string>) => Promise<void>,
): Promise<{ exitCode: number | null }> {
  const dir = await mkdtemp(join(testTmpdir(), "ak-mcp-relay-"));
  const socketPath = join(dir, "upstream.sock");
  const token = "relay-token";
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as { id: number; method: string; params?: unknown };
      handleUpstream(message, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const child = spawn(process.execPath, [relayPath], {
    env: { ...process.env, AK_GROK_MCP_SOCKET: socketPath, AK_GROK_MCP_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout! });
  const replies = lines[Symbol.asyncIterator]();
  try {
    await run(child, replies);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
    }
    return { exitCode: child.exitCode };
  } finally {
    lines.close();
    child.kill("SIGTERM");
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("MCP relay drains an in-flight tools/call after stdin EOF", { timeout: 8000 }, async () => {
  let release!: (socket: Socket, id: number) => void;
  const held = new Promise<{ socket: Socket; id: number }>((resolve) => {
    release = (socket, id) => resolve({ socket, id });
  });
  const result = await withRelay((message, socket) => {
    if (message.method === "tools/call") release(socket, message.id);
  }, async (child, replies) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ak_ping" } })}\n`);
    child.stdin!.end();
    const heldCall = await held;
    heldCall.socket.write(`${JSON.stringify({ id: heldCall.id, result: { ok: true } })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    assert.deepEqual(JSON.parse(line.value), { jsonrpc: "2.0", id: 2, result: { ok: true } });
  });
  assert.equal(result.exitCode, 0);
});

test("MCP relay delivers a reply larger than the OS pipe buffer before exiting 0", { timeout: 15000 }, async () => {
  // 8 MiB of upstream result — comfortably beyond any local OS pipe buffer —
  // so the relay must wait for stdout drain, not process.exit immediately.
  const big = "x".repeat(8 * 1024 * 1024);
  const result = await withRelay((message, socket) => {
    if (message.method === "tools/call") {
      socket.write(`${JSON.stringify({ id: message.id, result: { ok: true, data: big } })}\n`);
    }
  }, async (child, replies) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ak_big" } })}\n`);
    child.stdin!.end();
    const line = await replies.next();
    assert.equal(line.done, false);
    const body = JSON.parse(line.value) as { jsonrpc: string; id: number; result?: { ok: boolean; data: string } };
    assert.deepEqual(body.result, { ok: true, data: big });
  });
  assert.equal(result.exitCode, 0);
});

test("MCP relay exits nonzero when upstream dies before stdin EOF", { timeout: 8000 }, async () => {
  const result = await withRelay((message, socket) => {
    if (message.method === "tools/call") socket.destroy();
  }, async (child, replies) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ak_ping" } })}\n`);
    const line = await replies.next();
    assert.equal(line.done, false);
    const body = JSON.parse(line.value) as { error?: { message?: string } };
    assert.equal(typeof body.error?.message, "string");
    child.stdin!.end();
  });
  assert.equal(result.exitCode, 1);
});

test("MCP relay exits nonzero when stdin EOF precedes upstream death of an in-flight RPC", { timeout: 8000 }, async () => {
  let release!: (socket: Socket) => void;
  const held = new Promise<Socket>((resolve) => {
    release = resolve;
  });
  const result = await withRelay((message, socket) => {
    if (message.method === "tools/call") release(socket);
  }, async (child, replies) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await replies.next();
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ak_ping" } })}\n`);
    child.stdin!.end();
    const socket = await held;
    socket.destroy();
    const line = await replies.next();
    assert.equal(line.done, false);
    const body = JSON.parse(line.value) as { error?: { message?: string } };
    assert.equal(typeof body.error?.message, "string");
  });
  assert.equal(result.exitCode, 1);
});
