#!/usr/bin/env node
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.env.AK_GROK_MCP_SOCKET;
const token = process.env.AK_GROK_MCP_TOKEN;
if (!socketPath || !token) throw new Error("AK Grok MCP relay identity is missing");

const upstream = connect(socketPath);
const waiters = new Map();
let nextId = 0;
createInterface({ input: upstream }).on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = waiters.get(message.id);
  if (waiter === undefined) return;
  waiters.delete(message.id);
  if (message.error !== undefined) waiter.reject(new Error(message.error));
  else waiter.resolve(message.result);
});
function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    upstream.write(`${JSON.stringify({ id, token, method, params })}\n`);
  });
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function ok(id, result) { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); }
function fail(id, error) { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); }

createInterface({ input: process.stdin }).on("line", async (line) => {
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
process.on("SIGTERM", () => { upstream.end(); process.exit(0); });
