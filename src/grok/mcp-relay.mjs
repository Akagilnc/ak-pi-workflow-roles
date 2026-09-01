#!/usr/bin/env node
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.env.AK_GROK_MCP_SOCKET;
const token = process.env.AK_GROK_MCP_TOKEN;
if (!socketPath || !token) throw new Error("AK Grok MCP relay identity is missing");

const upstream = connect(socketPath);
const waiters = new Map();
let nextId = 0;
let terminalError;
function settle(error) {
  if (terminalError !== undefined) return;
  terminalError = error;
  for (const waiter of waiters.values()) waiter.reject(error);
  waiters.clear();
}
upstream.on("error", (error) => settle(error));
upstream.on("close", () => settle(new Error("AK Grok MCP upstream closed")));
createInterface({ input: upstream }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch (error) { settle(error); upstream.destroy(); return; }
  const waiter = waiters.get(message.id);
  if (waiter === undefined) return;
  waiters.delete(message.id);
  if (message.error !== undefined) {
    const error = new Error(typeof message.error.message === "string" ? message.error.message : "AK Grok MCP relay failure");
    error.code = message.error.code;
    error.cause = message.error;
    waiter.reject(error);
  } else waiter.resolve(message.result);
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
    });
  });
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function ok(id, result) { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); }
function fail(id, error) { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); }

const stdinLines = createInterface({ input: process.stdin });
stdinLines.on("line", async (line) => {
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
});
function shutdown() {
  stdinLines.close();
  upstream.end();
  process.exit(0);
}
// Parent harness ends stdin after the RPC exchange; exit cleanly (no SIGKILL).
stdinLines.on("close", shutdown);
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
