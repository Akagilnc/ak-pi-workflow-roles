import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../../src/compliance-transport.ts";
import { createDoctorRoleRuntime, DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-role.ts";

const zero = { count: 0, sources: [] }; const patient: any = { version: 1, identity: { issueNumber: 28, runsPath: "/case/.ak/work/issues/28/runs" }, evidence: [{ id: "review/session/live.jsonl", kind: "session", byteLength: 6, contentLength: 2, sha256: "abc", content: "中文" }], cost: { invocations: zero, legs: zero, modelApiTurns: zero, outputTokens: zero, toolCalls: zero, retries: { ...zero, evidence: "literal run-dir naming" }, statuses: [], commits: [], sessions: [], outputBytes: { ...zero, payload: "raw JSONL bytes", providerWireBytes: "unavailable" } } };
function harness() { const flags = new Map<string, unknown>([["ak-doctor-case", patient.identity.runsPath]]); const tools = new Map<string, any>(); const handlers = new Map<string, any>(); let active: string[] = []; const pi = { registerFlag(name: string, value: unknown) { if (!flags.has(name)) flags.set(name, value); }, getFlag(name: string) { return flags.get(name); }, registerTool(tool: any) { tools.set(tool.name, tool); }, getAllTools() { return ["read", "bash", ...tools.keys()].map((name) => ({ name })); }, setActiveTools(names: string[]) { active = names; }, getActiveTools() { return active; }, on(name: string, fn: any) { handlers.set(name, fn); } }; return { pi, tools, handlers, active: () => active }; }
function context(id: string, abort = () => {}, extras: Record<string, unknown> = {}): ExtensionContext { const sessionManager = SessionManager.inMemory(); const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id, name: DOCTOR_OUTPUT_TOOL_NAME, arguments: {} }], api: "openai-responses", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 }; sessionManager.appendMessage(message); return { sessionManager, abort, ...extras } as unknown as ExtensionContext; }
const refusal = { status: "refused", reason: "Session bytes are incomplete.", missingEvidence: [{ need: "session header", targetKeys: ["case"] }] };

test("Doctor activation exposes only paged session evidence and output tools", async () => { const h = harness(); const runtime = createDoctorRoleRuntime(h.pi as ExtensionAPI, { loadSoul: async () => "DOCTOR LAW", loadCase: async () => patient, auditCompliance: async () => ({ status: "pass" }) }, { failInfrastructure(error) { throw error; } }); await runtime.activate(); assert.deepEqual(h.active(), [DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME]); assert.deepEqual([...h.tools.keys()], [DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME]); assert.equal(typeof h.tools.get(DOCTOR_EVIDENCE_TOOL_NAME).parameters, "object"); assert.equal(typeof h.tools.get(DOCTOR_OUTPUT_TOOL_NAME).parameters, "object"); const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "BASE" }); assert.equal(prompt.systemPrompt.includes("DOCTOR LAW"), true); });

test("Doctor output audits testimony, seals runtime cost, and keeps failure behavior", async () => { let decision: "pass" | "revise" | "failure" = "revise"; let aborts = 0; const audited: any[] = []; const h = harness(); const runtime = createDoctorRoleRuntime(h.pi as ExtensionAPI, { loadSoul: async () => "DOCTOR LAW", loadCase: async () => patient, async auditCompliance(input) { audited.push(input); if (decision === "failure") throw new Error("provider unavailable"); return decision === "revise" ? { status: "revise", violations: ["missing method proof"] } : { status: "pass" }; } }, { failInfrastructure(error, ctx) { ctx.abort(); throw error; } }); await runtime.activate(); const output = h.tools.get(DOCTOR_OUTPUT_TOOL_NAME); await assert.rejects(output.execute("doctor", refusal, undefined, undefined, context("doctor")), /missing method proof/); decision = "pass"; assert.equal((await output.execute("doctor", refusal, undefined, undefined, context("doctor"))).terminate, true);
  const testimony = { status: "completed", case: patient.identity, findings: [] };
  const accepted = await output.execute("doctor", testimony, undefined, undefined, context("doctor"));
  assert.deepEqual(accepted.details, { ...testimony, cost: patient.cost });
  assert.deepEqual(audited.at(-1).testimony, testimony);
  assert.equal("cost" in audited.at(-1).testimony, false);
  await assert.rejects(output.execute("doctor", { ...testimony, presentation: "human-only" }, undefined, undefined, context("doctor")), /contract/); decision = "failure"; await assert.rejects(output.execute("doctor", refusal, undefined, undefined, context("doctor", () => { aborts++; })), /provider unavailable/); assert.equal(aborts, 1); });

test("stream idle timeout through Doctor output reaches failInfrastructure without a forged Receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let aborts = 0;
  const infrastructureCauses: unknown[] = [];
  const decisionTool = createComplianceDecisionTool(
    "ak_doctor_idle_probe_decision",
    "idle settlement probe",
  );
  const h = harness();
  try {
    const runtime = createDoctorRoleRuntime(h.pi as ExtensionAPI, {
      loadSoul: async () => "DOCTOR LAW",
      loadCase: async () => patient,
      async auditCompliance(_input, options) {
        // One shared terminating-role seam: real runComplianceAudit + default provider.stream path.
        return runComplianceAudit({
          tool: decisionTool,
          systemPrompt: "doctor idle probe",
          serializedInput: "doctor idle input",
          roleLabel: "Doctor Soul compliance audit",
          invalidDecisionLabel: "invalid Doctor audit decision",
          context: {
            ...options.context,
            model: {
              api: "openai-responses",
              provider: "doctor-idle-probe",
              id: "idle-model",
            },
            modelRegistry: {
              async getProviderAuth() {
                return { auth: { apiKey: "test-secret" } };
              },
              async getApiKeyAndHeaders() {
                return { ok: true as const, apiKey: "test-secret" };
              },
              getProvider() {
                return {
                  stream(_model: unknown, _context: unknown, request: { signal?: AbortSignal }) {
                    const signal = request.signal;
                    return {
                      async *[Symbol.asyncIterator]() {
                        await new Promise<never>((_resolve, reject) => {
                          if (!(signal instanceof AbortSignal)) return;
                          if (signal.aborted) {
                            reject(signal.reason);
                            return;
                          }
                          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                        });
                      },
                      result: async () => {
                        throw new Error("idle must abort before compliance result");
                      },
                    };
                  },
                };
              },
            },
          } as unknown as ExtensionContext,
          idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
    }, {
      failInfrastructure(error, ctx) {
        infrastructureCauses.push(error);
        // Mirror production print/json settlement (role-runtime failInfrastructure).
        if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = 1;
        ctx.abort();
        throw error;
      },
    });
    await runtime.activate();
    const output = h.tools.get(DOCTOR_OUTPUT_TOOL_NAME);
    const assertion = assert.rejects(
      output.execute(
        "doctor-idle",
        refusal,
        undefined,
        undefined,
        context("doctor-idle", () => { aborts += 1; }, { mode: "print" }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof StreamIdleTimeoutError);
        assert.equal(error.code, "AK_STREAM_IDLE_TIMEOUT");
        assert.equal(error.idleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
        return true;
      },
    );
    for (let attempt = 0; attempt <= DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await assertion;
    assert.equal(infrastructureCauses.length, 1);
    assert.ok(infrastructureCauses[0] instanceof StreamIdleTimeoutError);
    assert.equal(aborts, 1);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
