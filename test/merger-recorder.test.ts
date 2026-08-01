import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceCollector } from "../src/recorder/extract.ts";
import { TERMINATING_TOOL_NAMES } from "../src/package-contracts/terminating-tools.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const details = { status: "escalate", attemptId: "attempt", diagnosis: "authority decision", report: "cannot reconcile without guessing" };
const rows = [
  { type: "message", id: "a", parentId: null, timestamp: 1, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "ak_merger_output", arguments: details }], api: "test", provider: "test", model: "test", usage, stopReason: "toolUse", timestamp: 1 } },
  { type: "message", id: "r", parentId: "a", timestamp: 2, message: { role: "toolResult", toolCallId: "call", toolName: "ak_merger_output", content: [{ type: "text", text: "Merger output accepted" }], isError: false, details, timestamp: 2 } },
];

test("Recorder terminating census and extraction preserve a Merger receipt without audit or worker semantics", () => {
  assert.ok(TERMINATING_TOOL_NAMES.includes("ak_merger_output" as any));
  const collector = new AcceptanceCollector(); rows.forEach((row, i) => collector.accept(row, i));
  const result = collector.finish(rows.length);
  assert.deepEqual(result.receipt, { toolName: "ak_merger_output", toolCallId: "call", details, kind: "merger" });
  assert.equal(result.auditObservation, null);
});
