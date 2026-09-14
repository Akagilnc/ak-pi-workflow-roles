/**
 * #537 — pure engine-detour-usage contracts (no FS / no settlement).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINE_DETOUR_CALL_KIND,
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
  engineDetourCallIdentity,
  engineDetourStdoutByteLength,
  projectEngineDetourToolUsageForPublicTerminal,
  withEngineDetourToolUsageFact,
} from "../../src/engine-detour-usage.ts";

test("stdout byte length is UTF-8 Buffer.byteLength (empty is real 0)", () => {
  assert.equal(engineDetourStdoutByteLength(""), 0);
  assert.equal(engineDetourStdoutByteLength("abc"), 3);
  assert.equal(engineDetourStdoutByteLength("你好"), 6);
});

test("engineDetourCallIdentity binds run + invocation scope + toolCallId (not bare id)", () => {
  assert.equal(
    engineDetourCallIdentity({
      toolCallId: "t1",
      runId: "r1",
      invocationScopeId: "s1",
    }),
    "engine-detour-call:r1:s1:t1",
  );
  assert.notEqual(
    engineDetourCallIdentity({ toolCallId: "t1", runId: "r1", invocationScopeId: "s1" }),
    engineDetourCallIdentity({ toolCallId: "t1", runId: "r1", invocationScopeId: "s2" }),
  );
});

test("resumable public projection strips recordFile path disclosure", () => {
  const usage = {
    callCount: 1,
    calls: [{
      toolCallId: "c1",
      durationMs: 1,
      code: 0,
      stdoutByteLength: 0,
      recordPointer: {
        identity: "engine-detour-call:r:a:c1",
        recordFile: "/home/.ak-roles/books/x/unbound/runs/01abc@judge/session/k/records.jsonl",
        kind: ENGINE_DETOUR_CALL_KIND,
        level: "event" as const,
      },
    }],
  };
  const redacted = projectEngineDetourToolUsageForPublicTerminal(usage, {
    discloseRecordFile: false,
  });
  assert.equal(redacted.calls[0]?.recordPointer.identity, usage.calls[0]!.recordPointer.identity);
  assert.equal(redacted.calls[0]?.recordPointer.recordFile, "");
  assert.equal(
    projectEngineDetourToolUsageForPublicTerminal(usage, { discloseRecordFile: true }),
    usage,
  );
});

test("withEngineDetourToolUsageFact leaves role payloads untouched", () => {
  const payload = { status: "completed", report: "x" };
  const outcome = {
    kind: "accepted" as const,
    role: "coder" as const,
    payloads: [payload],
    decisiveFacts: { other: 1 },
  };
  const merged = withEngineDetourToolUsageFact(outcome, {
    callCount: 1,
    calls: [{
      toolCallId: "c2",
      durationMs: 2,
      code: 0,
      stdoutByteLength: 0,
      recordPointer: {
        identity: "i",
        recordFile: "/r",
        kind: ENGINE_DETOUR_CALL_KIND,
        level: "event",
      },
    }],
  });
  assert.equal(merged.payloads, outcome.payloads);
  assert.deepEqual(merged.payloads?.[0], payload);
  assert.equal(merged.decisiveFacts?.other, 1);
  const facts = merged.decisiveFacts as Record<string, unknown>;
  assert.equal(
    (facts[ENGINE_DETOUR_TOOL_USAGE_FACT_KEY] as { callCount: number }).callCount,
    1,
  );
  assert.equal(withEngineDetourToolUsageFact(outcome, undefined), outcome);
});
