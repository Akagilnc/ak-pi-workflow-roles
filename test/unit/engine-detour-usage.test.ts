/**
 * #537 — pure engine-detour-usage contracts (no FS / no settlement).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINE_DETOUR_CALL_KIND,
  ENGINE_DETOUR_TOOL_USAGE_FACT_KEY,
  engineDetourStdoutByteLength,
  withEngineDetourToolUsageFact,
} from "../../src/engine-detour-usage.ts";

test("stdout byte length is UTF-8 Buffer.byteLength (empty is real 0)", () => {
  assert.equal(engineDetourStdoutByteLength(""), 0);
  assert.equal(engineDetourStdoutByteLength("abc"), 3);
  assert.equal(engineDetourStdoutByteLength("你好"), 6);
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
