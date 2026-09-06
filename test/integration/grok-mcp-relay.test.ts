import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { worktreePackageRoot } from "../helpers/worktree-temp.ts";

import { packageRoot } from "../helpers/pi-test-harness.ts";

const relayPath = join(packageRoot, "src/grok/mcp-relay.mjs");

type UpstreamHandler = (message: { id: number; method: string; params?: unknown }, socket: Socket) => void;

function isRelativeInside(rel: string): boolean {
  return rel.length > 0 && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Prefer a short relative sun_path so deep checkout absolute paths do not truncate/collide. */
async function listenUnixSocket(server: Server, socketName: string, socketAbs: string): Promise<void> {
  const rel = relative(process.cwd(), socketAbs);
  const bindPath = isRelativeInside(rel)
    ? rel
    : Buffer.byteLength(socketAbs) < 100
      ? socketAbs
      : null;
  if (bindPath !== null) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPath, resolve);
    });
    return;
  }
  // Deep absolute path + cwd outside package root: brief chdir for short relative bind.
  const previousCwd = process.cwd();
  process.chdir(worktreePackageRoot);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketName, resolve);
    });
  } finally {
    process.chdir(previousCwd);
  }
}

async function withRelay(
  handleUpstream: UpstreamHandler,
  run: (child: ReturnType<typeof spawn>, replies: AsyncIterator<string>) => Promise<void>,
): Promise<{ exitCode: number | null }> {
  // Short relative socket under package root — no long mkdtemp path in sun_path.
  const socketName = `.r${process.pid.toString(36)}${Date.now().toString(36)}.sock`;
  const socketAbs = join(worktreePackageRoot, socketName);
  const token = "relay-token";
  let server: Server | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  // Acquire nothing before cleanup ownership: server/child only inside body.
  return withPrimaryAwareCleanup(
    async () => {
      server = createServer((socket) => {
        const upstreamLines = createInterface({ input: socket });
        upstreamLines.on("line", (line) => {
          const message = JSON.parse(line) as { id: number; method: string; params?: unknown };
          handleUpstream(message, socket);
        });
      });
      await listenUnixSocket(server, socketName, socketAbs);
      child = spawn(process.execPath, [relayPath], {
        cwd: worktreePackageRoot,
        env: { ...process.env, AK_GROK_MCP_SOCKET: socketName, AK_GROK_MCP_TOKEN: token },
        stdio: ["pipe", "pipe", "pipe"],
      });
      lines = createInterface({ input: child.stdout! });
      const replies = lines[Symbol.asyncIterator]();
      await run(child, replies);
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child!.once("exit", () => resolve());
          child!.once("error", () => resolve());
        });
      }
      return { exitCode: child.exitCode };
    },
    async () => {
      lines?.close();
      child?.kill("SIGTERM");
    },
    async () => {
      if (server === undefined) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    },
    async () => {
      await unlink(socketAbs).catch(() => {
        /* socket may already be gone */
      });
    },
  );
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
