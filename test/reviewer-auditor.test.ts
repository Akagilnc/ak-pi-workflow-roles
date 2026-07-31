import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  REVIEWER_AUDIT_TOOL_NAME,
  createPiReviewerAuditor,
} from "../src/reviewer-auditor.ts";

const input: any = {
  soul: "Reviewer law",
  canonicalSkill: "complete raw canonical Skill",
  task: "opaque task",
  record: {
    transportRejections: [],
    rejections: [],
    accepted: {
      identity: "dispatch-1", recipe: "reviewer-dispatch-v1" as const,
      input: { task: { text: "opaque task", utf8Length: 11, sha256: "task" }, canonicalSkillSha256: "skill", capabilityDocument: { text: "{}", utf8Length: 2, sha256: "capabilities" } },
      target: { repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "head", refs: {} },
      prerequisiteOperations: [],
      range: { base: "base", target: "head", diffCommand: "git diff base...head", diffSha256: "diff", commits: ["head"] },
      materials: { standards: [{ id: "rules", repositoryPath: "RULES.md", text: "rules", utf8Length: 5, sha256: "rules" }], noSpecEvidence: [{ id: "absence", repositoryPath: "README.md", text: "absence", utf8Length: 7, sha256: "absence" }] },
      legs: [{ axis: "standards" as const, prompt: { text: "Inspect the pinned diff", utf8Length: 23, sha256: "prompt" }, grant: { tools: ["read"] as const, bashCommands: [], prerequisiteOperations: [] } }],
    },
    started: { dispatchIdentity: "dispatch-1", cardinality: 1 as const },
    results: { standards: { dispatchIdentity: "dispatch-1", axis: "standards" as const, status: "successful" as const, prompt: { text: "Inspect the pinned diff", utf8Length: 23, sha256: "prompt" }, target: { repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "head", refs: {} }, report: "No findings", workspaceDisposition: "deleted" as const } },
  },
  candidate: {
    version: 2 as const, status: "completed" as const, acceptedBatch: { identity: "dispatch-1", legs: [] },
    reports: { standards: { text: "No findings", utf8Length: 11, sha256: "report" } },
    outcomes: {}, identities: { canonicalSkill: { sha256: "skill", utf8Length: 5, snapshotIdentity: "/skill" } },
  },
};

const context = {
  model: { provider: "test", id: "reviewer" },
  modelRegistry: {
    async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
    async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; },
  },
} as unknown as ExtensionContext;

test("Reviewer auditor receives complete method inputs and has only its decision tool", async () => {
  let seen: Context | undefined;
  const audit = createPiReviewerAuditor(async (_model, request) => {
    seen = request;
    return fauxAssistantMessage(
      fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, { status: "pass", violations: [] }),
      { stopReason: "toolUse" },
    );
  });

  assert.equal((await audit(input, { context })).status, "pass");
  assert.deepEqual(seen?.tools?.map((tool) => tool.name), [REVIEWER_AUDIT_TOOL_NAME]);
  const serialized = JSON.stringify(seen);
  for (const expected of [
    "Reviewer law",
    "complete raw canonical Skill",
    "opaque task",
    "No findings",
    "dispatch-1",
    "Inspect the pinned diff",
  ]) assert.match(serialized, new RegExp(expected));
  assert.match(textOfAuditContext(seen), /"dispatchIdentity":"dispatch-1"/);
  assert.match(seen?.systemPrompt ?? "", /not a second substantive reviewer/i);
  assert.match(seen?.systemPrompt ?? "", /Do not discover findings, rerank axes/i);
  assert.match(seen?.systemPrompt ?? "", /package adapter controls.*output mechanics/i);
  assert.match(seen?.systemPrompt ?? "", /Cross-axis material access or citation is lawful/i);
  assert.match(seen?.systemPrompt ?? "", /revise for a second-axis assessment, finding count, conclusion, or section/i);
  assert.match(seen?.systemPrompt ?? "", /Never apply source allowlists, parse prose mechanically/i);
});

function textOfAuditContext(seen: Context | undefined): string {
  const user = seen?.messages.find((message) => message.role === "user");
  if (user?.role !== "user") return "";
  return typeof user.content === "string"
    ? user.content
    : user.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

test("Reviewer auditor preserves active-provider authentication failures", async () => {
  const unavailable = {
    ...context,
    modelRegistry: {
      async getProviderAuth() { throw new Error("login expired"); },
    },
  } as unknown as ExtensionContext;
  await assert.rejects(
    createPiReviewerAuditor(async () => {
      throw new Error("completion must not run");
    })(input, { context: unavailable }),
    /Reviewer compliance audit authentication failed: login expired/,
  );
});

test("Reviewer auditor enforces exact pass or revise decisions", async () => {
  const revise = createPiReviewerAuditor(async () => fauxAssistantMessage(
    fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, {
      status: "revise",
      violations: ["Axis aggregation is not traceable"],
    }),
    { stopReason: "toolUse" },
  ));
  const decision = await revise(input, { context });
  assert.equal(decision.status, "revise");
  assert.deepEqual(
    decision.status === "revise" ? decision.violations : [],
    ["Axis aggregation is not traceable"],
  );

  const malformed = createPiReviewerAuditor(async () =>
    fauxAssistantMessage("not a tool decision"),
  );
  await assert.rejects(
    malformed(input, { context }),
    /invalid reviewer audit decision/,
  );
});
