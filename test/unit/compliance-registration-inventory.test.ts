import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiDoctorAuditor, DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../../src/fixer-auditor.ts";
import { createPiJudgeAuditor, JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { createPiReviewerAuditor, REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";

const extensionContext = {
  model: { provider: "test", id: "compliance-inventory" },
  modelRegistry: {
    async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
    async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "secret" }; },
  },
  sessionManager: SessionManager.inMemory(),
} as unknown as ExtensionContext;

const reviewerInput: any = {
  soul: "law", canonicalSkill: "skill", task: "task",
  record: {
    transportRejections: [], rejections: [],
    accepted: {
      identity: "dispatch", recipe: "reviewer-dispatch-v1",
      input: { task: { text: "task", utf8Length: 4, sha256: "task" }, canonicalSkillSha256: "skill", capabilityDocument: { text: "{}", utf8Length: 2, sha256: "cap" } },
      target: { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "head", refs: {} },
      prerequisiteOperations: [], range: { base: "base", target: "head", diffCommand: "git diff", diffSha256: "diff", commits: ["head"] },
      materials: { standards: [{ id: "rules", repositoryPath: "RULES.md", text: "rules", utf8Length: 5, sha256: "rules" }], noSpecEvidence: [] },
      legs: [{ axis: "standards", prompt: { text: "review", utf8Length: 6, sha256: "prompt" }, grant: { tools: ["read"], bashCommands: [], prerequisiteOperations: [] } }],
    },
    started: { dispatchIdentity: "dispatch", cardinality: 1 },
    results: { standards: { dispatchIdentity: "dispatch", axis: "standards", status: "successful", prompt: { text: "review", utf8Length: 6, sha256: "prompt" }, target: { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "head", refs: {} }, report: "ok", workspaceDisposition: "deleted" } },
  },
  candidate: { version: 2, status: "completed", acceptedBatch: { identity: "dispatch", legs: [] }, reports: { standards: { text: "ok" } }, outcomes: {}, identities: { canonicalSkill: { text: "skill" } } },
};

const cases = [
  { name: JUDGE_AUDIT_TOOL_NAME, run: (completion: any) => createPiJudgeAuditor(completion)({ soul: "law", transcript: "record", verdict: { judgeStatus: "converged" } }, { context: extensionContext }) },
  { name: FIXER_AUDIT_TOOL_NAME, run: (completion: any) => createPiFixerAuditor(completion)({ soul: "law", packet: {}, phase: "apply", transcript: "record", candidate: {} } as any, { context: extensionContext }) },
  { name: REVIEWER_AUDIT_TOOL_NAME, run: (completion: any) => createPiReviewerAuditor(completion)(reviewerInput, { context: extensionContext }) },
  { name: DOCTOR_AUDIT_TOOL_NAME, run: (completion: any) => createPiDoctorAuditor(completion)({ soul: "law", patient: { version: 1, identity: {}, cost: {}, evidence: [] } as any, readRecord: [], testimony: { status: "refused", reason: "none", missingEvidence: [] } }, { context: extensionContext }) },
] as const;

test("four production auditors register the canonical open compliance tool inventory", async () => {
  for (const seat of cases) {
    let outbound: Context | undefined;
    await seat.run(async (_model: unknown, request: Context) => {
      outbound = request;
      return fauxAssistantMessage(fauxToolCall(seat.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" });
    });

    assert.equal(outbound?.tools?.length, 1, seat.name);
    const tool = outbound?.tools?.[0];
    assert.equal(tool?.name, seat.name);
    const parameters = tool?.parameters as any;
    assert.equal(parameters.type, "object");
    assert.equal(parameters.anyOf, undefined);
    assert.equal(parameters.oneOf, undefined);
    assert.deepEqual(parameters.required, []);
    assert.equal(parameters.additionalProperties, true);
    assert.deepEqual(Object.keys(parameters.properties).sort(), ["status", "violations", "conflicts", "decisionGate"].sort());
    for (const declaration of Object.values(parameters.properties) as any[]) {
      assert.equal(typeof declaration.description, "string");
      assert.notEqual(declaration.description.trim(), "");
    }
    assert.equal(parameters.properties.decisionGate.anyOf.length, 2);
    const objectBranch = parameters.properties.decisionGate.anyOf.find((branch: any) => branch.type === "object");
    assert.ok(objectBranch);
    assert.deepEqual(Object.keys(objectBranch.properties).sort(), ["question", "options"].sort());
    assert.ok(parameters.properties.decisionGate.anyOf.some((branch: any) => branch.type === "null"));
  }
});
