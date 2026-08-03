import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Context, type Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../src/fixer-auditor.ts";

const input = {
  soul: "Fixer law exact bytes",
  packet: Object.freeze({ version: 1 as const, instructions: "Assigned finding packet", prerequisites: Object.freeze([{ id: "owner.choice", requirement: "Owner chooses." }]) }),
  phase: "apply" as const,
  transcript: "invocation transcript",
  candidate: { status: "completed" as const, report: "settled", classResults: [{ name: "Parser", disposition: "completed" as const, searchScope: "all parsers", exceptions: [], commitSha: "a".repeat(40) }] },
};
const context = { model: { provider: "active", id: "same-model" }, modelRegistry: {
  async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
  async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; },
}, sessionManager: SessionManager.inMemory() } as unknown as ExtensionContext;

test("Fixer auditor uses the active model, exact invocation inputs, and a non-overreaching fresh decision context", async () => {
  let model: Model<any> | undefined; let seen: Context | undefined;
  const audit = createPiFixerAuditor(async (actual, request) => { model = actual; seen = request; return fauxAssistantMessage(fauxToolCall(FIXER_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }); });
  assert.equal((await audit(input, { context })).status, "pass");
  assert.equal(model?.id, "same-model");
  assert.deepEqual(seen?.tools?.map((tool) => tool.name), [FIXER_AUDIT_TOOL_NAME]);
  const decisionTool = seen?.tools?.[0];
  const parameters = decisionTool?.parameters as any;
  assert.equal(parameters.type, "object");
  assert.equal(parameters.anyOf, undefined);
  assert.deepEqual(parameters.properties.status.anyOf.map((status: any) => status.const), ["pass", "revise", "escalate"]);
  assert.equal(parameters.additionalProperties, false);
  const userContent = seen?.messages.find((message) => message.role === "user")?.content;
  assert.ok(Array.isArray(userContent));
  const auditInput = userContent.map((part) => part.type === "text" ? part.text : "").join("");
  for (const exactInput of [input.soul, JSON.stringify(input.packet), input.phase, input.transcript, JSON.stringify(input.candidate)]) {
    assert.equal(auditInput.includes(exactInput), true);
  }
});

test("Fixer auditor returns revise and rejects malformed decisions", async () => {
  const revise = createPiFixerAuditor(async () => fauxAssistantMessage(fauxToolCall(FIXER_AUDIT_TOOL_NAME, { status: "revise", violations: ["unfinished workload was relabeled"], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }));
  assert.equal((await revise(input, { context })).status, "revise");
  await assert.rejects(createPiFixerAuditor(async () => fauxAssistantMessage("overreach"))(input, { context }), /invalid fixer audit decision/);
});

test("Fixer auditor preserves authentication, provider, and transport failures as infrastructure", async () => {
  const auth = { ...context, modelRegistry: { async getProviderAuth() { throw new Error("login expired"); } } } as unknown as ExtensionContext;
  await assert.rejects(createPiFixerAuditor()(input, { context: auth }), /Fixer compliance audit authentication failed: login expired/);
  const missingProvider = { ...context, modelRegistry: { ...(context as any).modelRegistry, getProvider() { return undefined; } } } as ExtensionContext;
  await assert.rejects(createPiFixerAuditor()(input, { context: missingProvider }), /Fixer compliance audit provider not found/);
  await assert.rejects(createPiFixerAuditor(async () => { throw new Error("transport disconnected"); })(input, { context }), /transport disconnected/);
});
