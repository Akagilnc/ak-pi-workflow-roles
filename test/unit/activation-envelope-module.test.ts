// #420 整改移档（自 test/integration/activation-envelope-contract.test.ts 与
// test/integration/activation-reconciliation.test.ts）：纯进程内模块逻辑按性质
// 归位快档；stdin-parked 真子进程条仍留 integration。契约断言一字不减。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";

import {
  ACCEPTED_ACTIVATION_EVENT,
  ActivationLedgerError,
  appendAcceptedActivationFact,
  buildAcceptedActivationFact,
  correlationIdentityFromEnv,
  resolveActivationLedgerHome,
  serializeAcceptedActivationFact,
  TOOL_EXECUTION_UPDATE_HEARTBEAT,
  TOOL_EXECUTION_UPDATE_THROTTLE_MS,
  createToolExecutionObservationFace,
  isProducingToolUpdate,
  systemToolExecutionObservationMonoNow,
  toolExecutionObservationRecordSchema,
  writeActivationTraceRecord,
  writeToolExecutionObservationRecord,
  type AcceptedActivationFact,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { activationTraceRecordSchema } from "../../src/activation-trace.ts";
import {
  DISPATCH_STUB_EVENT,
  buildDispatchStubFact,
  reconcileInvocation,
  type DispatchStubFact,
  type ReconciliationOutcome,
} from "../../src/activation-reconciliation.ts";

test("accepted-activation fact is closed at the typed API and omits injected content keys", () => {
  const closed: AcceptedActivationFact = {
    event: ACCEPTED_ACTIVATION_EVENT,
    role: "judge",
    observedAt: "2025-01-01T00:00:00.000Z",
    bookKey: "demo",
    session: { kind: "session-file", path: "/home/session.jsonl" },
    correlation: { kind: "caller", id: "c1" },
  };
  const injectedExtraKeys = ["prompt", "transcript", "argv", "excerpt", "content"] as const;
  const smuggled = {
    ...closed,
    prompt: "PROMPT_SECRET_BYTES",
    transcript: "transcript-body",
    argv: ["--ak-role", "judge"],
    excerpt: "excerpt-text",
    content: "nope",
  } as AcceptedActivationFact & Record<string, unknown>;
  // Closed at the typed construction API via descriptor-driven projection.
  assert.deepEqual(buildAcceptedActivationFact(smuggled), closed);

  // Serialized projection retains typed descriptor exclusion of injected content keys.
  // Exact key-set spelling/order is owned by the production descriptor + compile-time proof — not asserted here.
  const parsed = JSON.parse(serializeAcceptedActivationFact(smuggled)) as Record<string, unknown>;
  for (const key of injectedExtraKeys) {
    assert.equal(Object.hasOwn(parsed, key), false, `descriptor projection must omit injected ${key}`);
  }
  assert.deepEqual(correlationIdentityFromEnv({}), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "" }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "   " }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "\t\n" }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "abc" }), { kind: "caller", id: "abc" });
  // Non-blank caller value is preserved verbatim (including surrounding whitespace).
  assert.deepEqual(
    correlationIdentityFromEnv({ AK_CORRELATION_ID: "  keep-me  " }),
    { kind: "caller", id: "  keep-me  " },
  );
});

test("resolved ledger home rejects relative process home before filesystem writes", () => {
  for (const relativeHome of [".", "relative-home", ""] as const) {
    assert.throws(
      () => resolveActivationLedgerHome(relativeHome),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
  }

  const absoluteHome = resolve(tmpdir(), "ak-ledger-abs-home");
  const ledgerHome = resolveActivationLedgerHome(absoluteHome);
  assert.equal(isAbsolute(ledgerHome), true);
  assert.equal(ledgerHome, resolve(absoluteHome, ".ak-roles"));

  const root = mkdtempSync(join(tmpdir(), "ak-ledger-rel-home-"));
  try {
    const relativeLedgerHome = "relative-ledger-home";
    assert.equal(isAbsolute(relativeLedgerHome), false);
    assert.throws(
      () => appendAcceptedActivationFact(
        join(relativeLedgerHome, "books", "b", "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey: "b",
          session: { kind: "session-file", path: "/s/x.jsonl" },
          correlation: { kind: "absent" },
        }),
        { ledgerHome: relativeLedgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(existsSync(join(root, relativeLedgerHome)), false);
    assert.equal(existsSync(resolve(relativeLedgerHome)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function dispatchStub(input: {
  correlationId: string;
  bookKey: string;
  observedAt?: string;
  pid?: number;
}): DispatchStubFact {
  return buildDispatchStubFact({
    correlation: { kind: "caller", id: input.correlationId },
    bookKey: input.bookKey,
    observedAt: input.observedAt ?? "2025-06-01T12:00:00.000Z",
    dispatch: { kind: "process", pid: input.pid ?? 1 },
  });
}

function activationFact(input: {
  correlationId: string | "absent";
  bookKey: string;
  role?: string;
  sessionPath?: string;
  observedAt?: string;
}): AcceptedActivationFact {
  return buildAcceptedActivationFact({
    role: input.role ?? "judge",
    observedAt: input.observedAt ?? "2025-06-01T12:00:01.000Z",
    bookKey: input.bookKey,
    session: { kind: "session-file", path: input.sessionPath ?? "/tmp/session.jsonl" },
    correlation: input.correlationId === "absent"
      ? { kind: "absent" }
      : { kind: "caller", id: input.correlationId },
  });
}

test("dispatch stub fact is closed at the typed API and omits injected content keys", () => {
  const closed: DispatchStubFact = {
    event: DISPATCH_STUB_EVENT,
    observedAt: "2025-06-01T12:00:00.000Z",
    bookKey: "book-a",
    dispatch: { kind: "process", pid: 42 },
    correlation: { kind: "caller", id: "c-keys" },
  };
  const smuggled = {
    ...closed,
    prompt: "PROMPT_SECRET_BYTES",
    transcript: "transcript-body",
    argv: ["pi", "--ak-role", "judge"],
    excerpt: "excerpt-text",
    content: "nope",
  } as DispatchStubFact & Record<string, unknown>;
  assert.deepEqual(buildDispatchStubFact(smuggled), closed);
});

test("normal dispatch + accepted activation reconciles as matched", () => {
  const bookKey = "ak-roles-128";
  const correlationId = "corr-matched-1";
  const outcome = reconcileInvocation({
    dispatch: dispatchStub({ correlationId, bookKey }),
    activation: activationFact({ correlationId, bookKey }),
    process: { state: "alive" },
  });
  assert.deepEqual(outcome, {
    kind: "matched",
    correlationId,
    bookKey,
  } satisfies ReconciliationOutcome);
});

test("activation without a matching dispatch stub is activation-without-dispatch", () => {
  const bookKey = "ak-roles-128";

  // Caller correlation present but no stub at all.
  assert.deepEqual(
    reconcileInvocation({
      activation: activationFact({ correlationId: "orphan-1", bookKey }),
    }),
    {
      kind: "activation-without-dispatch",
      correlationId: "orphan-1",
      bookKey,
    } satisfies ReconciliationOutcome,
  );

  // Typed absent identity (no pre-assigned correlation) — mechanical anomaly.
  assert.deepEqual(
    reconcileInvocation({
      activation: activationFact({ correlationId: "absent", bookKey }),
    }),
    {
      kind: "activation-without-dispatch",
      correlationId: undefined,
      bookKey,
    } satisfies ReconciliationOutcome,
  );

  // Stub exists but book/correlation do not join — still no matching stub.
  assert.deepEqual(
    reconcileInvocation({
      dispatch: dispatchStub({ correlationId: "other", bookKey: "other-book" }),
      activation: activationFact({ correlationId: "orphan-2", bookKey }),
      process: { state: "alive" },
    }),
    {
      kind: "activation-without-dispatch",
      correlationId: "orphan-2",
      bookKey,
    } satisfies ReconciliationOutcome,
  );
});

function assertRetryingJsonlWriter(input: {
  write: (record: never, writeSync: typeof import("node:fs").writeSync) => void;
  record: unknown;
  schema: unknown;
  chunkSize: number;
  expectedFd?: number;
  invalidRecord?: unknown;
}): void {
  const chunks: Buffer[] = [];
  let calls = 0;
  input.write(
    input.record as never,
    ((_fd: number, buffer: Uint8Array, offset: number, length: number) => {
      if (input.expectedFd !== undefined) assert.equal(_fd, input.expectedFd);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      const count = Math.min(input.chunkSize, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    }) as typeof import("node:fs").writeSync,
  );
  const line = Buffer.concat(chunks).toString();
  assert.equal(line.endsWith("\n"), true);
  assert.equal(Value.Check(input.schema as never, JSON.parse(line)), true);
  assert.ok(calls > 2);
  if (input.invalidRecord !== undefined) {
    assert.throws(() => input.write(input.invalidRecord as never, (() => 0) as never), /observation record does not match its contract/);
  }
}

test("default trace and tool observation writers retry short writes and reject schema-invalid records", () => {
  assertRetryingJsonlWriter({
    write: writeActivationTraceRecord as never,
    record: { role: "judge", stageId: "load", status: "failed", timestamp: "2025-01-01T00:00:00.000Z", cause: { identity: "Error", name: "Error", message: "failed" } },
    schema: activationTraceRecordSchema,
    chunkSize: 7,
  });
  assertRetryingJsonlWriter({
    write: writeToolExecutionObservationRecord as never,
    record: {
      event: "tool_execution_start",
      role: "judge",
      toolCallId: "t1",
      toolName: "bash",
      timestamp: "2025-01-01T00:00:00.000Z",
    },
    schema: toolExecutionObservationRecordSchema,
    chunkSize: 9,
    expectedFd: 2,
    invalidRecord: { event: "nope" },
  });
});

test("tool-execution observation contract retains reader-required events and output-driven updates", () => {
  assert.equal(TOOL_EXECUTION_UPDATE_THROTTLE_MS, 30_000);
  assert.equal(TOOL_EXECUTION_UPDATE_HEARTBEAT, "output-driven");
  assert.equal(isProducingToolUpdate({ content: [], details: undefined }), false);
  assert.equal(
    isProducingToolUpdate({ content: [], details: { elapsedMs: 60_000 } }),
    false,
    "observation-plane heartbeat remains content-driven",
  );
  assert.equal(isProducingToolUpdate({ content: [{ type: "text", text: "" }] }), false);
  assert.equal(isProducingToolUpdate({ content: [{ type: "text", text: "chunk" }] }), true);
  for (const record of [
    { event: "tool_execution_start", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z" },
    { event: "tool_execution_update", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:30.000Z" },
    { event: "tool_execution_end", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:01:00.000Z", isError: false },
  ] as const) {
    assert.equal(Value.Check(toolExecutionObservationRecordSchema, record), true);
  }
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, {
    event: "tool_execution_end", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z",
  }), false);
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, {
    event: "tool_execution_start", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z", extra: true,
  }), true);
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
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [], details: { elapsedMs: 60_000 } } });
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
