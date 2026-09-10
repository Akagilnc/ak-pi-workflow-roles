import assert from "node:assert/strict";
import test from "node:test";
import type { DoctorCase } from "../../src/doctor-contracts.ts";
import { createDoctorRoleRuntime, DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-role.ts";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { createTempPackageHomeLedger } from "../helpers/pi-test-harness.ts";

// #604 F1: session/cwd must sit under temp `.ak-roles` so sitian path-derive never
// falls through to the real machine home (bare `/case` wrote books/case).
const doctorLedger = createTempPackageHomeLedger({
  prefix: "ak-doctor-role-",
  runName: "contract@doctor",
});
test.after(() => doctorLedger.dispose());

const zero = { count: 0, sources: [] }; const patient: DoctorCase = { version: 1, identity: { issueNumber: 28, runsPath: "/case/.ak/work/issues/28/runs" }, evidence: [{ id: "review/session/live.jsonl", kind: "session", byteLength: 6, contentLength: 2, sha256: "abc", content: "中文" }], cost: { invocations: zero, legs: zero, modelApiTurns: zero, outputTokens: zero, toolCalls: zero, retries: { ...zero, evidence: "literal run-dir naming" }, statuses: [], commits: [], sessions: [], outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" } } };
function harness() { const flags = new Map<string, boolean | string>([["ak-doctor-case", patient.identity.runsPath]]); const tools = new Map<string, HostToolDefinition>(); let beforeAgentStartResult: unknown; let active: string[] = []; const host: RoleHost = { registerFlag(name, definition) { if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default); }, getFlag: (name) => flags.get(name), registerTool(tool) { tools.set(tool.name, tool); }, getAllTools: () => ["read", "bash", ...tools.keys()].map((name) => ({ name })), setActiveTools(names) { active = names; }, getActiveTools: () => active, on(name, handler) { if (name === "before_agent_start") beforeAgentStartResult = handler({ prompt: "", systemPrompt: "BASE", systemPromptOptions: {}, text: "", toolName: "", toolCallId: "", input: {}, isError: false, content: [], details: undefined, reason: "", status: 200, messages: [], partialResult: undefined, turnIndex: 0, calls: [] }, context("doctor")); }, getCommands: () => [] }; return { host, tools, beforeAgentStartResult: () => beforeAgentStartResult, active: () => active }; }
function context(id: string, abort = () => {}, candidates: unknown[] = []): HostContext {
  const entries = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: DOCTOR_OUTPUT_TOOL_NAME, arguments: {} }] } }];
  return {
    cwd: doctorLedger.home,
    mode: "json",
    model: undefined,
    sessionManager: {
      getLeafEntry: () => entries.at(-1),
      getLeafId: () => id,
      getEntries: () => entries,
      getSessionDir: () => doctorLedger.sessionDirectory,
      getSessionFile: () => doctorLedger.sessionFile,
      // #836: capture the candidate entry so tests can see runtime cost
      // recorded beside (never merged into) the role's accepted payload.
      appendCustomEntry: (_type: string, data: unknown) => { candidates.push(data); },
    },
    abort,
  };
}
const refusal = { status: "refused" as const, reason: "Session bytes are incomplete.", missingEvidence: [{ need: "session header", targetKeys: ["case"] }] };

test("Doctor activation exposes only paged session evidence and output tools", async () => { const h = harness(); const soul = crypto.randomUUID(); const runtime = createDoctorRoleRuntime(h.host, { loadSoul: async () => soul, loadCase: async () => patient, auditCompliance: async () => ({ status: "pass" }) }, { failInfrastructure(error) { throw error; } }); await runtime.activate(); assert.deepEqual(h.active(), [DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME]); assert.deepEqual([...h.tools.keys()], [DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME]); assert.equal(typeof h.tools.get(DOCTOR_EVIDENCE_TOOL_NAME)?.parameters, "object"); assert.equal(typeof h.tools.get(DOCTOR_OUTPUT_TOOL_NAME)?.parameters, "object"); const prompt = await h.beforeAgentStartResult(); assert.ok(prompt && typeof prompt === "object" && "systemPrompt" in prompt); assert.ok(typeof prompt.systemPrompt === "string"); assert.equal(prompt.systemPrompt.includes(soul), true); });

test("Doctor output audits testimony, records runtime cost beside it, and keeps failure behavior", async () => {
  let decision: "pass" | "bounce" | "failure" | "no-receipt" = "bounce";
  let aborts = 0;
  let auditCalls = 0;
  // #775: structured violations must reach the parent seat with field content intact.
  const structuredViolation = {
    article: "method-proof",
    reason: "missing method proof",
    evidence: "case catalog lists no method bite",
  };
  // #836: the auditor's own no-receipt lifecycle facts — a machine fact about
  // the audit leg, never merged into the accepted testimony.
  const auditNoReceiptFacts = {
    status: "no-receipt" as const,
    terminalToolCalled: false,
    rejectedReceipts: [],
    deliveryTurns: 2 as const,
    sessionCompletion: "settled-without-accepted-receipt" as const,
    runPointer: "test-run",
    attemptPointer: "test-attempt",
    acceptedReceipt: false as const,
  };
  const h = harness();
  const runtime = createDoctorRoleRuntime(h.host, {
    loadSoul: async () => "DOCTOR LAW",
    loadCase: async () => patient,
    async auditCompliance(options) {
      auditCalls += 1;
      assert.ok(options.context);
      if (decision === "failure") throw new Error("provider unavailable");
      if (decision === "no-receipt") return auditNoReceiptFacts;
      return decision === "bounce"
        ? { status: "bounce", violations: [structuredViolation] }
        : { status: "pass" };
    },
  }, {
    failInfrastructure(error, ctx) { ctx.abort(); throw error; },
  });
  await runtime.activate();
  const output = h.tools.get(DOCTOR_OUTPUT_TOOL_NAME);
  assert.ok(output);
  await assert.rejects(
    output.execute("doctor", refusal, undefined, undefined, context("doctor")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // #775 acceptance: parent-visible text carries every structured field.
      assert.match(error.message, /method-proof/);
      assert.match(error.message, /missing method proof/);
      assert.match(error.message, /case catalog lists no method bite/);
      return true;
    },
  );
  decision = "pass";
  assert.equal((await output.execute("doctor", refusal, undefined, undefined, context("doctor"))).terminate, true);
  const testimony = { status: "completed" as const, case: patient.identity, findings: [] };
  const candidates: unknown[] = [];
  const accepted = await output.execute("doctor", testimony, undefined, undefined, context("doctor", () => {}, candidates));
  // #836: the accepted payload is the role's testimony, unmerged — runtime
  // cost never gets injected into it.
  assert.deepEqual(accepted.details, testimony);
  // Runtime cost is still a fact — recorded beside the testimony in the
  // candidate audit entry, not folded into the accepted payload.
  assert.deepEqual(candidates, [{ version: 1, testimony, cost: patient.cost, readRecord: [], patientIdentity: patient.identity }]);
  assert.equal(auditCalls, 3);
  decision = "no-receipt";
  const noReceiptCandidates: unknown[] = [];
  const noReceiptAccepted = await output.execute("doctor", testimony, undefined, undefined, context("doctor", () => {}, noReceiptCandidates));
  // #836: audit-no-receipt is a fact about the audit leg, not the role's
  // testimony — the accepted payload still equals testimony unmerged.
  assert.deepEqual(noReceiptAccepted.details, testimony);
  assert.equal(noReceiptAccepted.terminate, true);
  // The submission candidate is recorded pre-audit as always; the audit-leg
  // fact rides in its own second candidate entry alongside the same testimony.
  assert.deepEqual(noReceiptCandidates, [
    { version: 1, testimony, cost: patient.cost, readRecord: [], patientIdentity: patient.identity },
    { version: 1, testimony, cost: patient.cost, auditNoReceipt: auditNoReceiptFacts, readRecord: [], patientIdentity: patient.identity },
  ]);
  decision = "failure";
  await assert.rejects(output.execute("doctor", refusal, undefined, undefined, context("doctor", () => { aborts += 1; })), /provider unavailable/);
  assert.equal(aborts, 1);
});
