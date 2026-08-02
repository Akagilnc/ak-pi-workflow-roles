import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiDoctorAuditor, DOCTOR_AUDIT_TOOL_NAME } from "../src/doctor-auditor.ts";

const context = { model: { provider: "test", id: "doctor" }, modelRegistry: { async getProviderAuth() { return { auth: { apiKey: "secret" } }; }, async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; } } } as unknown as ExtensionContext;

test("Doctor audit receives the frozen evidence index without replaying large session content", async () => {
  let seen: Context | undefined;
  const audit = createPiDoctorAuditor(async (_model, request) => { seen = request; return fauxAssistantMessage(fauxToolCall(DOCTOR_AUDIT_TOOL_NAME, { status: "pass", violations: [] }), { stopReason: "toolUse" }); });
  const zero = { count: 0, sources: [] };
  const patient: any = { version: 1, identity: { issueNumber: 28, runsPath: "/case/.ak/work/issues/28/runs" }, evidence: [{ id: "review/session/live.jsonl", kind: "session", byteLength: 50_000_000, sha256: "abc", content: "LIVE_SECRET_SESSION_BYTES" }], cost: { invocations: { count: 1, sources: ["review"] }, legs: zero, modelApiTurns: zero, outputTokens: zero, toolCalls: zero, retries: { ...zero, evidence: "literal run-dir naming" }, statuses: [], commits: [], sessions: [], outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" } } };
  await audit({ soul: "Doctor law", patient, readRecord: [{ evidenceId: "review/session/live.jsonl", fullyRead: true }], testimony: { status: "refused", reason: "missing", missingEvidence: [{ need: "bytes", targetKeys: ["review"] }] } }, { context });
  const serialized = JSON.stringify(seen);
  assert.doesNotMatch(serialized, /LIVE_SECRET_SESSION_BYTES/);
  assert.match(serialized, /review\/session\/live\.jsonl/);
  assert.match(serialized, /50000000/);
  assert.match(serialized, /Doctor law/);
  assert.match(serialized, /proposed_doctor_testimony/);
  assert.doesNotMatch(serialized, /proposed_doctor_output/);
});
