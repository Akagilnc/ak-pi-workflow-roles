import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ROLE_REGISTRY, createRoleRuntimeExtension } from "../src/role-runtime.ts";
import type { ActivationTraceRecord } from "../src/activation-trace.ts";

test("registration enrolls every role in stable named activation stages", () => {
  assert.equal(ROLE_REGISTRY.length, 8);
  for (const entry of ROLE_REGISTRY) {
    assert.ok(entry.stages.length > 0);
    assert.equal(new Set(entry.stages).size, entry.stages.length);
    for (const id of entry.stages) assert.match(id, /^[a-z][a-z0-9-]*$/);
  }
});

test("a rejected registered activation fails closed with a structured named cause and dispatch barrier", async () => {
  const handlers = new Map<string, Function[]>();
  const traces: ActivationTraceRecord[] = [];
  let aborts = 0;
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => { throw new TypeError("soul unavailable"); },
    transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: () => "2025-01-01T00:00:00.000Z", activationTraceWriter: (record) => traces.push(record),
  })(pi);
  const ctx = { mode: "print", abort() { aborts++; } } as unknown as ExtensionContext;
  await assert.rejects(() => handlers.get("session_start")![0]!({}, ctx), /soul unavailable/);
  assert.equal(aborts, 1);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(traces.map(({ role, stageId, status }) => ({ role, stageId, status })), [
    { role: "judge", stageId: "load-and-install", status: "started" },
    { role: "judge", stageId: "load-and-install", status: "failed" },
  ]);
  const failure = traces[1]!;
  assert.equal(failure.status, "failed");
  if (failure.status === "failed") assert.deepEqual(failure.cause, { name: "TypeError", message: "soul unavailable" });
  await assert.rejects(async () => handlers.get("before_agent_start")![0]!({}, ctx), /did not complete/);
  process.exitCode = undefined;
});
