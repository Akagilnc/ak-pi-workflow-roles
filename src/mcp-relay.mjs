#!/usr/bin/env node
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.env.AK_ACP_MCP_SOCKET;
const token = process.env.AK_ACP_MCP_TOKEN;
if (!socketPath || !token) throw new Error("AK ACP MCP relay identity is missing");

const upstream = connect(socketPath);
const waiters = new Map();
let nextId = 0;
let terminalError;
let shutdownRequested = false;
let exiting = false;
let inFlight = 0;
let pendingStdout = 0;

function exitStatus() {
  return terminalError === undefined ? 0 : 1;
}

function maybeExit() {
  if (!shutdownRequested || exiting) return;
  if (inFlight > 0 || waiters.size > 0 || pendingStdout > 0) return;
  exiting = true;
  stdinLines.close();
  if (!upstream.destroyed) upstream.end();
  process.exit(exitStatus());
}

function requestShutdown() {
  shutdownRequested = true;
  maybeExit();
}

function settle(error) {
  if (terminalError !== undefined) return;
  terminalError = error;
  for (const waiter of waiters.values()) waiter.reject(error);
  waiters.clear();
  maybeExit();
}

upstream.on("error", (error) => settle(error));
upstream.on("close", () => {
  // Shutdown may already be requested (stdin EOF) while an RPC is still
  // in flight. Outstanding waiters must still settle, or drain never ends.
  if (!exiting) settle(new Error("AK ACP MCP upstream closed"));
  maybeExit();
});
createInterface({ input: upstream }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch (error) { settle(error); upstream.destroy(); return; }
  const waiter = waiters.get(message.id);
  if (waiter === undefined) return;
  waiters.delete(message.id);
  if (message.error !== undefined) {
    const error = new Error(typeof message.error.message === "string" ? message.error.message : "AK ACP MCP relay failure");
    error.code = message.error.code;
    error.cause = message.error;
    waiter.reject(error);
  } else waiter.resolve(message.result);
  maybeExit();
});
function request(method, params = {}) {
  if (terminalError !== undefined) return Promise.reject(terminalError);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    upstream.write(`${JSON.stringify({ id, token, method, params })}\n`, (error) => {
      if (error === null || error === undefined) return;
      const waiter = waiters.get(id);
      if (waiter === undefined) return;
      waiters.delete(id);
      waiter.reject(error);
      maybeExit();
    });
  });
}
function send(message) {
  const payload = `${JSON.stringify(message)}\n`;
  pendingStdout += 1;
  process.stdout.write(payload, (error) => {
    pendingStdout -= 1;
    if (error) settle(error);
    maybeExit();
  });
}
function ok(id, result) { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); }
function fail(id, error) { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); }

const stdinLines = createInterface({ input: process.stdin });
stdinLines.on("line", async (line) => {
  inFlight += 1;
  try {
    let message;
    try { message = JSON.parse(line); }
    catch (error) { fail(null, error); return; }
    try {
      if (message.method === "initialize") {
        ok(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ak-role-envelope", version: "1" } });
      } else if (message.method === "ping") {
        ok(message.id, {});
      } else if (message.method === "tools/list") {
        ok(message.id, await request("tools/list"));
      } else if (message.method === "tools/call") {
        ok(message.id, await request("tools/call", message.params));
      } else if (message.method !== "notifications/initialized" && message.method !== "initialized") {
        fail(message.id, new Error(`Unsupported MCP method: ${String(message.method)}`));
      }
    } catch (error) { fail(message.id, error); }
  } finally {
    inFlight -= 1;
    maybeExit();
  }
});
stdinLines.on("close", requestShutdown);
process.on("SIGTERM", requestShutdown);
