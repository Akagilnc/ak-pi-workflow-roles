import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createPiDoctorAuditor, DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";

const context = { model: { provider: "test", id: "doctor" }, modelRegistry: { async getProviderAuth() { return { auth: { apiKey: "secret" } }; }, async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; } }, sessionManager: SessionManager.inMemory() } as unknown as ExtensionContext;

test("Doctor audit receives the frozen evidence index without replaying large session content", async () => {
  let seen: Context | undefined;
  const audit = createPiDoctorAuditor(async (_model, request) => { seen = request; return fauxAssistantMessage(fauxToolCall(DOCTOR_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }); });
  const zero = { count: 0, sources: [] };
  const patient: any = { version: 1, identity: { issueNumber: 28, runsPath: "/case/.ak/work/issues/28/runs" }, evidence: [{ id: "review/session/live.jsonl", kind: "session", byteLength: 50_000_000, sha256: "abc", content: "LIVE_SECRET" }], cost: { invocations: { count: 1, sources: ["review"] }, legs: zero, modelApiTurns: zero, outputTokens: zero, toolCalls: zero, retries: { ...zero, evidence: "literal run-dir naming" }, statuses: [], commits: [], sessions: [], outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" } } };
  await audit({ soul: "Doctor law", patient, readRecord: [{ evidenceId: "review/session/live.jsonl", fullyRead: true }], testimony: { status: "refused", reason: "missing", missingEvidence: [{ need: "bytes", targetKeys: ["review"] }] } }, { context });
  const user = seen?.messages.find((message) => message.role === "user");
  assert.ok(user?.role === "user");
  assert.ok(Array.isArray(user.content));
  const text = user.content.find((part) => part.type === "text");
  assert.ok(text?.type === "text");
  const contractDelimiter = "\n<decision_tool_contract>\n";
  const sections = text.text.split(contractDelimiter);
  assert.equal(sections.length, 2, "Doctor audit must append its decision contract delimiter");
  assert.match(sections[1]!, /[\s\S]*\n<\/decision_tool_contract>$/);
  const payload = JSON.parse(sections[0]!);
  assert.deepEqual(Object.keys(payload).sort(), ["frozenEvidenceIndex", "proposedTestimony", "readRecord", "soul"]);
  assert.equal(payload.soul, "Doctor law");
  assert.deepEqual(payload.readRecord, [{ evidenceId: "review/session/live.jsonl", fullyRead: true }]);
  assert.equal(payload.frozenEvidenceIndex.evidence[0].byteLength, 50_000_000);
  assert.equal("content" in payload.frozenEvidenceIndex.evidence[0], false);
  assert.equal(JSON.stringify(payload).includes("LIVE_SECRET_SESSION_BYTES"), false);
});
