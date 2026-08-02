import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceCollector } from "../src/recorder/extract.ts";

const zero = { count: 0, sources: [] };
const cost = { invocations: zero, legs: zero, modelApiTurns: zero, outputTokens: zero, toolCalls: zero, retries: { ...zero, evidence: "literal run-dir naming" }, statuses: [], commits: [], sessions: [], outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" } };
const testimony = { status: "completed", case: { issueNumber: 40, runsPath: ".ak/work/issues/40/runs" }, findings: [] };
const receipt = { ...testimony, cost };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function rows(argumentsValue: unknown, details: unknown) {
  return [
    { type: "message", id: "issued", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "ak_doctor_output", arguments: argumentsValue }], api: "test", provider: "test", model: "test", usage, stopReason: "toolUse", timestamp: 1 } },
    { type: "message", id: "result", parentId: "issued", timestamp: "2026-01-01T00:00:01Z", message: { role: "toolResult", toolCallId: "call", toolName: "ak_doctor_output", content: [{ type: "text", text: "Doctor output accepted" }], isError: false, details } },
  ];
}
function extract(argumentsValue: unknown, details: unknown) { const collector = new AcceptanceCollector(); rows(argumentsValue, details).forEach((row, index) => collector.accept(row, index)); return collector.finish(2); }

test("Recorder accepts only Doctor runtime cost augmentation", () => {
  assert.deepEqual(extract(testimony, receipt).receipt.details, receipt);
  const refusal = { status: "refused", reason: "missing", missingEvidence: [{ need: "bytes", targetKeys: ["case"] }] };
  assert.deepEqual(extract(refusal, refusal).receipt.details, refusal);
});

test("Recorder rejects changed testimony, malformed cost, and other augmentation", () => {
  assert.throws(() => extract(testimony, { ...receipt, findings: [{ targetKey: "case", observation: "changed", evidenceIds: ["e"] }] }), /acceptance lifecycle is invalid/);
  assert.throws(() => extract(testimony, { ...receipt, cost: { ...cost, toolCalls: { count: -1, sources: [] } } }), /acceptance lifecycle is invalid/);
  assert.throws(() => extract(testimony, { ...receipt, extra: true }), /acceptance lifecycle is invalid/);
  assert.throws(() => extract({ ...testimony, cost }, receipt), /acceptance lifecycle is invalid/);
});
