import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ActivationBarrierError,
  ROLE_REGISTRY,
  createRoleRuntimeExtension,
  executeActivationStages,
  writeActivationTraceRecord,
  type ActivationStage,
} from "../src/role-runtime.ts";
import { activationTraceRecordSchema, type ActivationTraceRecord } from "../src/activation-trace.ts";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

test("registration enrolls every role in stable named activation stages", () => {
  assert.equal(ROLE_REGISTRY.length, 8);
  for (const entry of ROLE_REGISTRY) {
    assert.ok(entry.stages.length > 0);
    assert.equal(new Set(entry.stages.map(({ id }) => id)).size, entry.stages.length);
    for (const stage of entry.stages) {
      assert.equal(Value.Check(activationTraceRecordSchema, { role: entry.role, stageId: stage.id, status: "started", timestamp: "2025-01-01T00:00:00.000Z" }), true);
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
  mode?: ExtensionContext["mode"];
} = {}) {
  type Handler = (event: { reason?: string; systemPrompt?: string }, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const traces: ActivationTraceRecord[] = [];
  let aborts = 0;
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: options.activate ?? (async () => { throw new TypeError("soul unavailable"); }),
    transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: options.clock ?? (() => "2025-01-01T00:00:00.000Z"),
    activationTraceWriter: options.writeTrace ?? ((record) => { traces.push(record); }),
  })(pi);
  const ctx = { mode: options.mode ?? "print", abort() { aborts++; } } as unknown as ExtensionContext;
  const handler = (name: string): Handler => {
    const found = handlers.get(name)?.[0];
    assert.ok(found, `missing ${name} handler`);
    return found;
  };
  return { handler, traces, ctx, aborts: () => aborts };
}

test("a rejected registered activation fails closed with a structured named cause and dispatch barrier", async () => {
  const h = runtimeHarness();
  await assert.rejects(async () => h.handler("session_start")({}, h.ctx), /soul unavailable/);
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(h.traces.map(({ role, stageId, status }) => ({ role, stageId, status })), [
    { role: "judge", stageId: "load-and-install", status: "started" },
    { role: "judge", stageId: "load-and-install", status: "failed" },
  ]);
  for (const trace of h.traces) assert.equal(Value.Check(activationTraceRecordSchema, trace), true);
  const failure = h.traces[1]!;
  assert.equal(failure.status, "failed");
  if (failure.status === "failed") assert.deepEqual(failure.cause, { name: "TypeError", message: "soul unavailable" });
  await assert.rejects(async () => h.handler("before_agent_start")({}, h.ctx), (error: unknown) => error instanceof ActivationBarrierError && error.code === "AK_ACTIVATION_NOT_ADMITTED");
});

for (const failure of ["clock", "writer"] as const) {
  test(`${failure} failure terminates before activation instead of degrading silently`, async () => {
    let activations = 0;
    const infrastructureError = new Error(`${failure} unavailable`);
    const h = runtimeHarness({
      activate: async () => { activations++; return "SOUL"; },
      ...(failure === "clock" ? { clock: () => { throw infrastructureError; } } : { writeTrace: () => { throw infrastructureError; } }),
    });
    await assert.rejects(async () => h.handler("session_start")({}, h.ctx), infrastructureError);
    assert.equal(activations, 0);
    assert.equal(h.aborts(), 1);
    assert.equal(process.exitCode, 1);
    });
}

test("completed trace emission failure still terminates the invocation", async () => {
  const traceError = new Error("completion trace unavailable");
  let writes = 0;
  const h = runtimeHarness({
    activate: async () => "SOUL",
    writeTrace: () => { if (++writes === 2) throw traceError; },
  });
  await assert.rejects(async () => h.handler("session_start")({}, h.ctx), traceError);
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
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
    async () => h.handler("session_start")({}, h.ctx),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === activationError && error.errors[1] === traceError,
  );
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
});


test("default trace writer retries transient and short writes until one complete JSONL record", () => {
  const chunks: Buffer[] = [];
  let calls = 0;
  writeActivationTraceRecord(
    { role: "judge", stageId: "load", status: "started", timestamp: "2025-01-01T00:00:00.000Z" },
    ((_fd: number, buffer: Uint8Array, offset: number, length: number) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      const count = Math.min(7, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    }) as typeof import("node:fs").writeSync,
  );
  const line = Buffer.concat(chunks).toString();
  assert.equal(line.endsWith("\n"), true);
  assert.equal(Value.Check(activationTraceRecordSchema, JSON.parse(line)), true);
  assert.ok(calls > 2);
});

test("executor rejects schema-invalid dependency output without emitting it", async () => {
  const traces: ActivationTraceRecord[] = [];
  await assert.rejects(() => executeActivationStages("judge", [{ id: "load", run: async () => {} }], {
    clock: () => "invalid", writeTrace: (record) => { traces.push(record); },
  }), /closed contract/);
  assert.deepEqual(traces, []);
});


for (const [mode, expected] of [["print", 1], ["json", 1], ["tui", undefined], ["rpc", undefined]] as const) {
  test(`activation failure applies ${mode} exit-code policy`, async () => {
    process.exitCode = undefined;
    const h = runtimeHarness({ mode });
    await assert.rejects(async () => h.handler("session_start")({}, h.ctx));
    assert.equal(process.exitCode, expected);
  });
}
