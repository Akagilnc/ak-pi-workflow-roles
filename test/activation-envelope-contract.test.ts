import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
import { canonicalSnapshotDigestV1 } from "../src/navigator-contracts.ts";
import { packageRoot, runPiSubprocess, withHermeticHome } from "./helpers/pi-test-harness.ts";

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
      "ak-doctor-case": "/case", "ak-navigator-snapshot": "/snapshot.json", "ak-merger-input": "/merger.json",
    };
    const tools: Array<{ name: string }> = entry.role === "merger" ? ["read", "grep", "find", "ls", "bash", "write", "edit"].map((name) => ({ name })) : [];
    let activeTools: string[] = [];
    const pi = {
      registerFlag() {}, registerTool(tool: { name: string }) { tools.push(tool); }, setActiveTools(names: string[]) { activeTools = [...names]; }, getActiveTools() { return activeTools; }, getAllTools() { return tools; },
      getFlag(name: string) { return flags[name]; },
      on(name: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    } as unknown as ExtensionAPI;
    const digest = "0ebb429fa86d481c2630fac53db1c91cffed5d4d41d1021c179444eb67e7ee0b";
    const snapshotBase = { version: 1 as const, capturedAt: "2025-01-01T00:00:00.000Z", runId: "018f22a0-7b4c-7abc-8def-0123456789ab", subject: { repositoryRoot: "/repository", github: { owner: "o", name: "r", id: "R" }, parent: { number: 1, id: "I" } }, children: [], parentObservation: { state: "open" as const, labels: [], observedAt: "2025-01-01T00:00:00.000Z", query: { transport: "github_rest" as const, operation: "issue" } }, labelPolicy: [], workspaces: [{ id: "w", root: "/repository", relation: "repository" as const, head: "a".repeat(40), target: "a".repeat(40) }], evidence: [], positionCursor: 0, latestAttempt: null };
    const snapshot = { ...snapshotBase, digest: canonicalSnapshotDigestV1(snapshotBase) };
    const material = (text: string) => ({ bytesBase64: Buffer.from(text).toString("base64"), sha256: createHash("sha256").update(text).digest("hex") });
    const mergerInput = { version: 1 as const, attemptId: "attempt", targetObjectId: "a".repeat(40), sourceObjectId: "b".repeat(40), materials: { task: material("task"), authority: material("authority"), targetIntent: material("target"), sourceIntent: material("source") }, expectedConflictPaths: ["same.txt"], resolutionScope: ["same.txt"], authorizedChecks: [{ name: "test", argv: ["npm", "test"] }] };
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "LAW", loadFixerSoul: async () => "LAW", loadCoderSoul: async () => "LAW",
      loadReviewerSoul: async () => "LAW", loadCollectorSoul: async () => "LAW", loadDoctorSoul: async () => "LAW",
      loadNavigatorSoul: async () => "LAW", loadMergerSoul: async () => "LAW",
      loadFixPacket: async () => JSON.stringify({ version: 1, instructions: "repair", prerequisites: [] }),
      loadCoderTask: async () => "task", loadReviewerTask: async () => new TextEncoder().encode("task"),
      loadReviewerCapabilities: async () => new TextEncoder().encode(JSON.stringify({ version: 1, taskSha256: digest, tools: [], prerequisiteOperations: ["preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range", "preflight.git.list-ordered-commits", "preflight.git.read-material", "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot"] })),
      loadCanonicalSkillBinding: async (name) => ({ name, snapshot: { raw: "skill", path: "/skill", baseDir: "/", body: "skill", snapshotIdentity: { sha256: digest, utf8Length: 5 } }, invocation: (request: string) => request, captureExpansion: () => undefined }) as never,
      createReviewerPinnedGitReader: async () => ({ pin: { repositoryRoot: "/repository", objectFormat: "sha1", targetHead: "a".repeat(40), refs: {} } }) as never, reviewerHostTools: [],
      createCollectorTransport: () => ({}) as never,
      loadDoctorCase: async () => ({ version: 1, identity: { issueNumber: 1, runsPath: "/case" }, evidence: [], cost: {}, statuses: [], commits: [], sessions: [], outputBytes: {} }) as never,
      loadNavigatorSnapshot: async () => snapshot, loadNavigatorEvidence: async () => new Map(),
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
      "ak-navigator-snapshot": "/lawful/snapshot.json",
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
      loadNavigatorSoul: reject,
      loadNavigatorSnapshot: reject,
      loadNavigatorEvidence: reject,
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
    assert.deepEqual(failed.cause, { identity: "TypeError", name: "TypeError", message: `${entry.role} activation rejected` });
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
  if (failure.status === "failed") assert.deepEqual(failure.cause, { identity: "TypeError", name: "TypeError", message: "soul unavailable" });
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
