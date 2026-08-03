import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionError } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ActivationBarrierError,
  ROLE_REGISTRY,
  TOOL_EXECUTION_OBSERVATION_SCHEMA_VERSION,
  TOOL_EXECUTION_UPDATE_HEARTBEAT,
  TOOL_EXECUTION_UPDATE_THROTTLE_MS,
  createRoleRuntimeExtension,
  createToolExecutionObservationFace,
  executeActivationStages,
  isProducingToolUpdate,
  systemToolExecutionObservationMonoNow,
  toolExecutionObservationRecordSchema,
  writeActivationTraceRecord,
  writeToolExecutionObservationRecord,
  type ActivationStage,
  type ToolExecutionObservationRecord,
} from "../src/role-runtime.ts";
import { activationTraceRecordSchema, type ActivationTraceRecord } from "../src/activation-trace.ts";
import { packageRoot, runPiSubprocess, withHermeticHome, withInProcessPi } from "./helpers/pi-test-harness.ts";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

test("registration enrolls every role in stable named activation stages", () => {
  assert.equal(ROLE_REGISTRY.length, 7);
  for (const entry of ROLE_REGISTRY) {
    assert.ok(entry.stages.length > 0);
    assert.equal(new Set(entry.stages.map(({ id }) => id)).size, entry.stages.length);
    for (const stage of entry.stages) {
      assert.equal(Value.Check(activationTraceRecordSchema, { role: entry.role, stageId: stage.id, status: "started", timestamp: "2025-01-01T00:00:00.000Z" }), true);
      assert.equal(typeof stage.run, "function");
    }
  }
});

test("every registered healthy production ignition leaves structured start and completion traces", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "ak-activation-healthy-"));
  const collectorManifest = resolve(fixture, "legs.json");
  await writeFile(collectorManifest, JSON.stringify({ version: 1, legs: [{ id: "gate", expectedAuthors: ["gatebot"], request: { body: "review" } }] }));
  try {
  for (const entry of ROLE_REGISTRY) {
    const traces: ActivationTraceRecord[] = [];
    const handlers = new Map<string, Array<(event: { reason?: string }, ctx: ExtensionContext) => unknown>>();
    const flags: Record<string, unknown> = {
      "ak-role": entry.role,
      "ak-fixer-phase": "apply", "ak-fix-packet": "/packet.json",
      "ak-coder-phase": "apply", "ak-coder-task": "/task.md",
      "ak-review-task": "/task.md", "ak-review-capabilities": "/capabilities.json",
      "ak-collector-repo": "owner/repo", "ak-collector-pr": "1", "ak-collector-legs": collectorManifest,
      "ak-doctor-case": "/case", "ak-merger-input": "/merger.json",
    };
    const tools: Array<{ name: string }> = entry.role === "merger" ? ["read", "grep", "find", "ls", "bash", "write", "edit"].map((name) => ({ name })) : [];
    let activeTools: string[] = [];
    const pi = {
      registerFlag() {}, registerTool(tool: { name: string }) { tools.push(tool); }, setActiveTools(names: string[]) { activeTools = [...names]; }, getActiveTools() { return activeTools; }, getAllTools() { return tools; },
      getFlag(name: string) { return flags[name]; },
      on(name: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    } as unknown as ExtensionAPI;
    const digest = "0ebb429fa86d481c2630fac53db1c91cffed5d4d41d1021c179444eb67e7ee0b";
    const material = (text: string) => ({ bytesBase64: Buffer.from(text).toString("base64"), sha256: createHash("sha256").update(text).digest("hex") });
    const mergerInput = { version: 1 as const, attemptId: "attempt", targetObjectId: "a".repeat(40), sourceObjectId: "b".repeat(40), materials: { task: material("task"), authority: material("authority"), targetIntent: material("target"), sourceIntent: material("source") }, expectedConflictPaths: ["same.txt"], resolutionScope: ["same.txt"], authorizedChecks: [{ name: "test", argv: ["npm", "test"] }] };
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "LAW", loadFixerSoul: async () => "LAW", loadCoderSoul: async () => "LAW",
      loadReviewerSoul: async () => "LAW", loadCollectorSoul: async () => "LAW", loadDoctorSoul: async () => "LAW",
      loadMergerSoul: async () => "LAW",
      loadFixPacket: async () => JSON.stringify({ version: 1, instructions: "repair", prerequisites: [] }),
      loadCoderTask: async () => "task", loadReviewerTask: async () => new TextEncoder().encode("task"),
      loadReviewerCapabilities: async () => new TextEncoder().encode(JSON.stringify({ version: 1, taskSha256: digest, tools: [], prerequisiteOperations: ["preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range", "preflight.git.list-ordered-commits", "preflight.git.read-material", "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot"] })),
      loadCanonicalSkillBinding: async (name) => ({ name, snapshot: { raw: "skill", path: "/skill", baseDir: "/", body: "skill", snapshotIdentity: { sha256: digest, utf8Length: 5 } }, invocation: (request: string) => request, captureExpansion: () => undefined }) as never,
      createReviewerPinnedGitReader: async () => ({ pin: { repositoryRoot: "/repository", objectFormat: "sha1", targetHead: "a".repeat(40), refs: {} } }) as never, reviewerHostTools: [],
      createCollectorTransport: () => ({}) as never,
      loadDoctorCase: async () => ({ version: 1, identity: { issueNumber: 1, runsPath: "/case" }, evidence: [], cost: {}, statuses: [], commits: [], sessions: [], outputBytes: {} }) as never,
      loadMergerInput: async () => mergerInput,
      mergerGitState: { activeMerge: async () => ({ targetObjectId: "a".repeat(40), sourceObjectId: "b".repeat(40), unmergedPaths: ["same.txt"], automaticMergeTreeId: "d".repeat(40) }), completedMerge: async () => ({}) as never },
      transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }),
      activationClock: () => "2025-01-01T00:00:00.000Z", activationTraceWriter: (record) => { traces.push(record); },
    })(pi);
    const start = handlers.get("session_start")?.[0];
    assert.ok(start);
    await start({ reason: "startup" }, { mode: "print", cwd: "/repository", abort() {} } as unknown as ExtensionContext);
    assert.deepEqual(traces.map(({ role, stageId, status }) => ({ role, stageId, status })), entry.stages.flatMap(({ id }) => [
      { role: entry.role, stageId: id, status: "started" }, { role: entry.role, stageId: id, status: "completed" },
    ]));
    for (const trace of traces) assert.equal(Value.Check(activationTraceRecordSchema, trace), true);
  }
  } finally { await rm(fixture, { recursive: true, force: true }); }
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

test("every registered whole-activation rejection terminates nonzero with a named cause before a model turn", async () => {
  for (const entry of ROLE_REGISTRY) {
    process.exitCode = undefined;
    const handlers = new Map<string, Array<(event: { reason?: string }, ctx: ExtensionContext) => unknown>>();
    const traces: ActivationTraceRecord[] = [];
    let aborts = 0;
    let providerTurns = 0;
    const flags: Record<string, unknown> = {
      "ak-role": entry.role,
      "ak-doctor-case": "/lawful/case",
      "ak-merger-input": "/lawful/merger.json",
    };
    const rejection = new TypeError(`${entry.role} activation rejected`);
    const reject = async (): Promise<never> => { throw rejection; };
    const pi = {
      registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
      getFlag(name: string) { return flags[name]; },
      on(name: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as ExtensionAPI;
    createRoleRuntimeExtension({
      loadJudgeSoul: reject,
      loadFixerSoul: reject,
      loadCoderSoul: reject,
      loadReviewerSoul: reject,
      loadCollectorSoul: reject,
      loadDoctorSoul: reject,
      loadMergerSoul: reject,
      createMergerGitState: () => ({ activeMerge: reject, completedMerge: reject }),
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" }),
      activationClock: () => "2025-01-01T00:00:00.000Z",
      activationTraceWriter: (record) => { traces.push(record); },
    })(pi);
    const ctx = { mode: "print", cwd: "/repository", abort() { aborts++; } } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    assert.ok(start);
    await assert.rejects(async () => start({ reason: "startup" }, ctx), rejection);

    // Pi reaches its provider only after all before_agent_start handlers admit dispatch.
    await assert.rejects(async () => {
      for (const before of handlers.get("before_agent_start") ?? []) await before({}, ctx);
      providerTurns++;
    }, (error: unknown) => error instanceof ActivationBarrierError);
    assert.equal(providerTurns, 0, `${entry.role} reached the provider`);
    assert.equal(aborts, 2);
    assert.equal(process.exitCode, 1);
    const failed = traces.find((trace) => trace.status === "failed");
    assert.ok(failed && failed.status === "failed");
    assert.equal(failed.cause.identity, "TypeError");
    assert.equal(failed.cause.name, "TypeError");
    assert.equal(failed.cause.message, `${entry.role} activation rejected`);
    if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
    assert.match(failed.cause.evidenceId, /^activation-cause-/);
  }
});

test("incident 2026-08-02: malformed Fixer prerequisites fail the real Pi subprocess before provider dispatch", async () => {
  await withHermeticHome({ prefix: "ak-fixer-activation-incident-" }, async ({ home, agentDir }) => {
    const instructions = resolve(home, "instructions.md");
    const prerequisites = resolve(home, "prerequisites.json");
    await writeFile(instructions, "Apply the assigned repair.\n");
    await writeFile(prerequisites, JSON.stringify({ prerequisites: [] }));
    const result = await runPiSubprocess([
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session",
      "-e", resolve(packageRoot, "extensions/role-runtime.ts"),
      "-e", resolve(packageRoot, "test/fixtures/fixer-audit-failure-provider.ts"),
      "--ak-role", "fixer", "--ak-fixer-phase", "apply", "--ak-fix-packet", instructions,
      "--ak-fixer-prerequisites", prerequisites,
      "--provider", "ak-fixer-audit-failure", "--model", "faux-1", "-p", "Apply.",
    ], { cwd: packageRoot, timeoutMs: 15_000, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
    assert.equal(result.timedOut, false, "malformed prerequisites subprocess did not time out");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /FIXER_AUDIT_FAILURE_PROVIDER_CALLS=0/);
    const traces = result.stderr.split("\n").flatMap((line) => {
      try { const value = JSON.parse(line) as ActivationTraceRecord; return Value.Check(activationTraceRecordSchema, value) ? [value] : []; }
      catch { return []; }
    });
    assert.deepEqual(traces.map(({ role, stageId, status }) => ({ role, stageId, status })), [
      { role: "fixer", stageId: "load-and-install", status: "started" },
      { role: "fixer", stageId: "load-and-install", status: "failed" },
    ]);
    const failed = traces[1];
    assert.ok(failed?.status === "failed");
    assert.equal(failed.cause.identity, "AK_INVALID_FIX_PACKET");
    assert.match(failed.cause.message, /Fixer prerequisites/);
  });
});

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
  if (failure.status === "failed") {
    assert.equal(failure.cause.identity, "TypeError");
    assert.equal(failure.cause.name, "TypeError");
    assert.equal(failure.cause.message, "soul unavailable");
    if (typeof failure.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
    assert.match(failure.cause.evidenceId, /^activation-cause-/);
  }
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

test("tool-execution observation contract is versioned, closed, and output-driven", () => {
  assert.equal(TOOL_EXECUTION_OBSERVATION_SCHEMA_VERSION, 1);
  assert.equal(TOOL_EXECUTION_UPDATE_THROTTLE_MS, 30_000);
  assert.equal(TOOL_EXECUTION_UPDATE_HEARTBEAT, "output-driven");
  assert.equal(isProducingToolUpdate({ content: [], details: undefined }), false);
  assert.equal(isProducingToolUpdate({ content: [{ type: "text", text: "" }] }), false);
  assert.equal(isProducingToolUpdate({ content: [{ type: "text", text: "chunk" }] }), true);
  for (const record of [
    { schemaVersion: 1, event: "tool_execution_start", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z" },
    { schemaVersion: 1, event: "tool_execution_update", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:30.000Z" },
    { schemaVersion: 1, event: "tool_execution_end", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:01:00.000Z", isError: false },
  ] as const) {
    assert.equal(Value.Check(toolExecutionObservationRecordSchema, record), true);
  }
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, {
    schemaVersion: 1, event: "tool_execution_end", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z",
  }), false);
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, {
    schemaVersion: 1, event: "tool_execution_start", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z", extra: true,
  }), false);
});

test("observation face emits start/end always, throttles producing updates per toolCallId, and ignores non-admitted sessions", async () => {
  const records: ToolExecutionObservationRecord[] = [];
  let admitted = true;
  let mono = 0;
  const face = createToolExecutionObservationFace({
    role: () => "fixer",
    admitted: () => admitted,
    clock: () => new Date(1_700_000_000_000 + mono).toISOString(),
    monoNow: () => mono,
    write: (record) => { records.push(record); },
  });

  await face.onStart({ toolCallId: "a", toolName: "bash" });
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [] } });
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [{ type: "text", text: "one" }] } });
  mono = 10_000;
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [{ type: "text", text: "two" }] } });
  mono = 30_000;
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [{ type: "text", text: "three" }] } });
  await face.onEnd({ toolCallId: "a", toolName: "bash", isError: false });

  await face.onStart({ toolCallId: "b", toolName: "read" });
  await face.onStart({ toolCallId: "c", toolName: "bash" });
  await face.onUpdate({ toolCallId: "b", toolName: "read", partialResult: { content: [{ type: "text", text: "b-out" }] } });
  await face.onUpdate({ toolCallId: "c", toolName: "bash", partialResult: { content: [{ type: "text", text: "c-out" }] } });
  await face.onEnd({ toolCallId: "b", toolName: "read", isError: true });
  await face.onEnd({ toolCallId: "c", toolName: "bash", isError: false });

  admitted = false;
  const before = records.length;
  await face.onStart({ toolCallId: "d", toolName: "bash" });
  await face.onUpdate({ toolCallId: "d", toolName: "bash", partialResult: { content: [{ type: "text", text: "nope" }] } });
  await face.onEnd({ toolCallId: "d", toolName: "bash", isError: false });
  assert.equal(records.length, before);

  assert.deepEqual(records.map((record) => (
    record.event === "tool_execution_end"
      ? { event: record.event, toolCallId: record.toolCallId, isError: record.isError }
      : { event: record.event, toolCallId: record.toolCallId }
  )), [
    { event: "tool_execution_start", toolCallId: "a" },
    { event: "tool_execution_update", toolCallId: "a" },
    { event: "tool_execution_update", toolCallId: "a" },
    { event: "tool_execution_end", toolCallId: "a", isError: false },
    { event: "tool_execution_start", toolCallId: "b" },
    { event: "tool_execution_start", toolCallId: "c" },
    { event: "tool_execution_update", toolCallId: "b" },
    { event: "tool_execution_update", toolCallId: "c" },
    { event: "tool_execution_end", toolCallId: "b", isError: true },
    { event: "tool_execution_end", toolCallId: "c", isError: false },
  ]);
  for (const record of records) {
    assert.equal(Value.Check(toolExecutionObservationRecordSchema, record), true);
    assert.equal(record.role, "fixer");
    assert.equal(record.schemaVersion, 1);
  }
});

test("observation face rejects throttleMs override at the typed call site and ignores it at runtime", async () => {
  // Typed surface has no throttleMs — excess key must not type-check.
  const faceOptions = {
    role: () => "fixer" as string | undefined,
    admitted: () => true,
    clock: () => "2025-01-01T00:00:00.000Z",
    monoNow: () => 0,
    write: (_record: ToolExecutionObservationRecord) => {},
  };
  type FaceOptions = Parameters<typeof createToolExecutionObservationFace>[0];
  type HasThrottleMs = "throttleMs" extends keyof FaceOptions ? true : false;
  const throttleMsOnFaceOptions: HasThrottleMs = false;
  assert.equal(throttleMsOnFaceOptions, false);

  // Runtime: smuggled throttleMs: 0 must not disable the 30s coalesce.
  const records: ToolExecutionObservationRecord[] = [];
  let mono = 0;
  const face = createToolExecutionObservationFace({
    ...faceOptions,
    throttleMs: 0,
    monoNow: () => mono,
    write: (record) => { records.push(record); },
  } as FaceOptions);

  await face.onStart({ toolCallId: "t", toolName: "bash" });
  await face.onUpdate({
    toolCallId: "t",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "first" }] },
  });
  mono = 10_000; // < TOOL_EXECUTION_UPDATE_THROTTLE_MS
  await face.onUpdate({
    toolCallId: "t",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "second" }] },
  });

  assert.deepEqual(records.map((r) => r.event), [
    "tool_execution_start",
    "tool_execution_update",
  ]);
});

test("shared role runtime registers tool observation only after admitted activation and never writes stdout", async () => {
  const observations: ToolExecutionObservationRecord[] = [];
  type Handler = (event: Record<string, unknown>, ctx?: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "LAW",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: () => "2025-01-01T00:00:00.000Z",
    activationTraceWriter: () => {},
    toolExecutionObservationWriter: (record) => { observations.push(record); },
  })(pi);

  const startHandler = handlers.get("tool_execution_start")?.[0];
  const updateHandler = handlers.get("tool_execution_update")?.[0];
  const endHandler = handlers.get("tool_execution_end")?.[0];
  assert.ok(startHandler && updateHandler && endHandler);

  await startHandler({ toolCallId: "pre", toolName: "bash" });
  await updateHandler({ toolCallId: "pre", toolName: "bash", partialResult: { content: [{ type: "text", text: "x" }] } });
  await endHandler({ toolCallId: "pre", toolName: "bash", isError: false });
  assert.equal(observations.length, 0);

  const sessionStart = handlers.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ reason: "startup" }, { mode: "print", abort() {} } as unknown as ExtensionContext);

  await startHandler({ toolCallId: "post", toolName: "bash" });
  await updateHandler({ toolCallId: "post", toolName: "bash", partialResult: { content: [] } });
  await updateHandler({ toolCallId: "post", toolName: "bash", partialResult: { content: [{ type: "text", text: "hello" }] } });
  await endHandler({ toolCallId: "post", toolName: "bash", isError: true });
  assert.deepEqual(observations.map((record) => ({
    event: record.event,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    role: record.role,
    ...(record.event === "tool_execution_end" ? { isError: record.isError } : {}),
  })), [
    { event: "tool_execution_start", toolCallId: "post", toolName: "bash", role: "judge" },
    { event: "tool_execution_update", toolCallId: "post", toolName: "bash", role: "judge" },
    { event: "tool_execution_end", toolCallId: "post", toolName: "bash", role: "judge", isError: true },
  ]);
});

test("default tool observation writer retries short writes on fd 2 and rejects schema-invalid records", () => {
  const chunks: Buffer[] = [];
  let calls = 0;
  writeToolExecutionObservationRecord(
    { schemaVersion: 1, event: "tool_execution_start", role: "judge", toolCallId: "t1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z" },
    ((_fd: number, buffer: Uint8Array, offset: number, length: number) => {
      assert.equal(_fd, 2);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      const count = Math.min(9, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    }) as typeof import("node:fs").writeSync,
  );
  const line = Buffer.concat(chunks).toString();
  assert.equal(line.endsWith("\n"), true);
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, JSON.parse(line)), true);
  assert.ok(calls > 2);
  assert.throws(
    () => writeToolExecutionObservationRecord({ event: "nope" } as never),
    /closed contract/,
  );
});

test("tool observation writer failure does not fake success on the face", async () => {
  const face = createToolExecutionObservationFace({
    role: () => "judge",
    admitted: () => true,
    clock: () => "2025-01-01T00:00:00.000Z",
    monoNow: () => 0,
    write: () => { throw new Error("stderr unavailable"); },
  });
  await assert.rejects(async () => face.onStart({ toolCallId: "x", toolName: "bash" }), /stderr unavailable/);
});

test("production observation mono clock is monotonic and not wall-clock Date.now", () => {
  const samples = Array.from({ length: 32 }, () => systemToolExecutionObservationMonoNow());
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]! >= samples[i - 1]!, `monoNow must not go backwards: ${samples[i - 1]} -> ${samples[i]}`);
  }
  // Date.now is epoch ms (~1e12); performance.now is process-relative ms (far smaller in tests).
  assert.ok(samples[0]! < 1e11, `production monoNow must not default to wall-clock Date.now; got ${samples[0]}`);
});

test("observation writer failure aborts through real ExtensionRunner emit with original cause", async () => {
  await withHermeticHome({ prefix: "ak-tool-obs-fail-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-tool-obs-fail", provider: "ak-tool-obs-fail" });
    const writerError = new Error("stderr unavailable");
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let aborts = 0;
    const extensionErrors: ExtensionError[] = [];
    try {
      await withInProcessPi({
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "JUDGE",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createRoleRuntimeExtension({
          loadJudgeSoul: async () => "LAW",
          transcriptFromContext: () => "",
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationClock: () => "2025-01-01T00:00:00.000Z",
          activationTraceWriter: () => {},
          toolExecutionObservationWriter: () => { throw writerError; },
        })],
      }, async ({ session }) => {
        session.extensionRunner.onError((error) => { extensionErrors.push(error); });
        // Rebind abort so the infrastructure path is observable without depending on agent internals.
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => { aborts += 1; },
        });
        // emit() swallows handler throws after emitError — termination must still have run.
        await session.extensionRunner.emit({
          type: "tool_execution_start",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          args: {},
        });
        assert.equal(aborts, 1, "observation failure must call ExtensionContext.abort");
        assert.equal(process.exitCode, 1, "print mode observation failure must set nonzero exitCode");
        assert.ok(
          extensionErrors.some((error) => error.event === "tool_execution_start" && error.error.includes("stderr unavailable")),
          `ExtensionRunner must retain the original cause via extension error; got ${JSON.stringify(extensionErrors)}`,
        );

        // Same termination for update and end seams.
        aborts = 0;
        process.exitCode = undefined;
        extensionErrors.length = 0;
        await session.extensionRunner.emit({
          type: "tool_execution_update",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          args: {},
          partialResult: { content: [{ type: "text", text: "chunk" }] },
        });
        assert.equal(aborts, 1);
        assert.equal(process.exitCode, 1);
        assert.ok(extensionErrors.some((error) => error.event === "tool_execution_update" && error.error.includes("stderr unavailable")));

        aborts = 0;
        process.exitCode = undefined;
        extensionErrors.length = 0;
        await session.extensionRunner.emit({
          type: "tool_execution_end",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          isError: false,
          result: { content: [], details: {} },
        });
        assert.equal(aborts, 1);
        assert.equal(process.exitCode, 1);
        assert.ok(extensionErrors.some((error) => error.event === "tool_execution_end" && error.error.includes("stderr unavailable")));
      });
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
