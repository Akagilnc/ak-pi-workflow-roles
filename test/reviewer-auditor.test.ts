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

const input = {
  soul: "Reviewer law",
  canonicalSkill: "complete raw canonical Skill",
  task: "opaque task",
  record: { bashEvidence: [], agentAttempts: [] },
  candidate: { status: "refused" as const, report: "Target cannot be established." },
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
    "Target cannot be established",
  ]) assert.match(serialized, new RegExp(expected));
  assert.match(seen?.systemPrompt ?? "", /not a second substantive reviewer/i);
  assert.match(seen?.systemPrompt ?? "", /Do not discover findings, rerank axes/i);
});

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
