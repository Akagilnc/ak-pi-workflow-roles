import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ROLE_REGISTRY,
  createRoleRuntimeExtension,
  executeActivationStages,
  type ActivationStage,
} from "../src/role-runtime.ts";
import type { ActivationTraceRecord } from "../src/activation-trace.ts";

test("registration enrolls every role in stable named activation stages", () => {
  assert.equal(ROLE_REGISTRY.length, 8);
  for (const entry of ROLE_REGISTRY) {
    assert.ok(entry.stages.length > 0);
    assert.equal(new Set(entry.stages.map(({ id }) => id)).size, entry.stages.length);
    for (const stage of entry.stages) {
      assert.match(stage.id, /^[a-z][a-z0-9-]*$/);
      assert.equal(typeof stage.run, "function");
    }
  }
});

test("the shared executor runs every declared stage in order", async () => {
  const calls: string[] = [];
  const stages: ActivationStage[] = [
    { id: "first", run: async () => { calls.push("first"); } },
    { id: "second", run: async () => { calls.push("second"); } },
  ];
  await executeActivationStages("judge", stages, {
    clock: () => "2025-01-01T00:00:00.000Z",
    writeTrace: (record) => { calls.push(`${record.stageId}:${record.status}`); },
  });
  assert.deepEqual(calls, ["first:started", "first", "first:completed", "second:started", "second", "second:completed"]);
});

function runtimeHarness(options: {
  activate?: () => Promise<string>;
  clock?: () => string;
  writeTrace?: (record: ActivationTraceRecord) => void | Promise<void>;
} = {}) {
  const handlers = new Map<string, Function[]>();
  const traces: ActivationTraceRecord[] = [];
  let aborts = 0;
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: options.activate ?? (async () => { throw new TypeError("soul unavailable"); }),
    transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: options.clock ?? (() => "2025-01-01T00:00:00.000Z"),
    activationTraceWriter: options.writeTrace ?? ((record) => { traces.push(record); }),
  })(pi);
  const ctx = { mode: "print", abort() { aborts++; } } as unknown as ExtensionContext;
  return { handlers, traces, ctx, aborts: () => aborts };
}

test("a rejected registered activation fails closed with a structured named cause and dispatch barrier", async () => {
  const h = runtimeHarness();
  await assert.rejects(() => h.handlers.get("session_start")![0]!({}, h.ctx), /soul unavailable/);
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(h.traces.map(({ role, stageId, status }) => ({ role, stageId, status })), [
    { role: "judge", stageId: "load-and-install", status: "started" },
    { role: "judge", stageId: "load-and-install", status: "failed" },
  ]);
  const failure = h.traces[1]!;
  assert.equal(failure.status, "failed");
  if (failure.status === "failed") assert.deepEqual(failure.cause, { name: "TypeError", message: "soul unavailable" });
  await assert.rejects(async () => h.handlers.get("before_agent_start")![0]!({}, h.ctx), /did not complete/);
  process.exitCode = undefined;
});

for (const failure of ["clock", "writer"] as const) {
  test(`${failure} failure terminates before activation instead of degrading silently`, async () => {
    let activations = 0;
    const infrastructureError = new Error(`${failure} unavailable`);
    const h = runtimeHarness({
      activate: async () => { activations++; return "SOUL"; },
      ...(failure === "clock" ? { clock: () => { throw infrastructureError; } } : { writeTrace: () => { throw infrastructureError; } }),
    });
    await assert.rejects(() => h.handlers.get("session_start")![0]!({}, h.ctx), infrastructureError);
    assert.equal(activations, 0);
    assert.equal(h.aborts(), 1);
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
  });
}

test("completed trace emission failure still terminates the invocation", async () => {
  const traceError = new Error("completion trace unavailable");
  let writes = 0;
  const h = runtimeHarness({
    activate: async () => "SOUL",
    writeTrace: () => { if (++writes === 2) throw traceError; },
  });
  await assert.rejects(() => h.handlers.get("session_start")![0]!({}, h.ctx), traceError);
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
});

test("failed trace emission cannot mask the activation cause or skip termination", async () => {
  const activationError = new TypeError("soul unavailable");
  const traceError = new Error("trace unavailable");
  let writes = 0;
  const h = runtimeHarness({
    activate: async () => { throw activationError; },
    writeTrace: async () => { if (++writes === 2) throw traceError; },
  });
  await assert.rejects(
    () => h.handlers.get("session_start")![0]!({}, h.ctx),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === activationError && error.errors[1] === traceError,
  );
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
});
