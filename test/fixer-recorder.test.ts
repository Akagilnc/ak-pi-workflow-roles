import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceCollector } from "../src/recorder/extract.ts";

const details = { status: "completed", report: "settled", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const absentUsage = Symbol("absent usage");
function lifecycle(candidate: unknown, auditUsage: unknown = usage) {
  return [
    { type: "message", id: "assistant", parentId: null, timestamp: 1, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "ak_fixer_output", arguments: candidate }], api: "test", provider: "test", model: "active", usage, stopReason: "toolUse", timestamp: 1 } },
    { type: "message", id: "result", parentId: "assistant", timestamp: 2, message: { role: "toolResult", toolCallId: "call", toolName: "ak_fixer_output", content: [{ type: "text", text: "Fixer report accepted" }], isError: false, details: candidate, ...(auditUsage === absentUsage ? {} : { usage: auditUsage }) } },
  ];
}
function extract(candidate: unknown, auditUsage: unknown = usage) { const collector = new AcceptanceCollector(); const rows = lifecycle(candidate, auditUsage); rows.forEach((row, index) => collector.accept(row, index)); return collector.finish(rows.length); }

test("Recorder accepts only the current Fixer leaf and emits its audit observation", () => {
  const result = extract(details);
  assert.deepEqual(result.receipt.details, details);
  assert.deepEqual(result.auditObservation, { toolName: "ak_fixer_output", toolCallId: "call", auditPassed: true, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
  assert.throws(() => extract(details, absentUsage), /acceptance lifecycle is invalid/);
  assert.throws(() => extract(details, { input: 1 }), /acceptance lifecycle is invalid/);
  assert.throws(() => extract({ status: "completed", report: "legacy", commitSha: "abc", classesRepaired: [] }), /acceptance lifecycle is invalid/);
  assert.throws(() => extract({ status: "refused", report: "legacy", classResults: [{ name: "Policy", disposition: "refused", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", evidence: "old leaf" } }] }), /acceptance lifecycle is invalid/);
});

test("Recorder preserves a current typed prerequisite leaf and audit usage unchanged", () => {
  const prerequisite = { status: "refused", report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "Choice absent." } }] };
  const result = extract(prerequisite);
  assert.deepEqual(result.receipt.details, prerequisite);
  assert.deepEqual(result.auditObservation?.usage, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 });
});
