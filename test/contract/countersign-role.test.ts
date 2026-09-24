import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { closeJsonSchemaForCodex } from "../../src/headless-host/description.ts";
import { terminatingToolJsonSchema } from "../../src/role-envelope.ts";
import {
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  validateRecordedCountersignOutput,
} from "../../src/countersign-contracts.ts";
import { countersignVerdictSchema } from "../../src/countersign-role.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { inspectorOutputSchema } from "../../src/inspector-role.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { judgeVerdictSchema } from "../../src/judge-role.ts";
import { AUDITOR_OUTPUT_TOOL_NAME, auditorOutputSchema } from "../../src/package-contracts/auditor-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME, notaryOutputSchema } from "../../src/notary-contracts.ts";
import { REVIEW_QUEUE_WORDS, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, reviewSubmissionSchema } from "../../src/review-submission.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";

/** Shared mock host harness for the Countersign runtime. */
function countersignHarness() {
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const roleHost = {
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) { if (event === "before_agent_start") beforeStart = handler; },
    getAllTools() { return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }]; },
  };
  return { tools, roleHost, beforeStart: () => beforeStart };
}

test("validateRecordedCountersignOutput recognizes 署/封驳/上呈 read-only — 原卷保真", () => {
  // 原卷保真 (ADR 0055): lawful verdicts are delivered untouched — no field
  // defaulted, renamed, or dropped (#572 判词送修 2).
  const sealedBack = validateRecordedCountersignOutput({
    status: "continue",
    findings: ["x"],
    evidence: "e-1",
  }) as unknown as Record<string, unknown>;
  assert.equal(sealedBack.status, "continue");
  assert.equal("disposition" in sealedBack, false, "no disposition default may be injected");
  assert.deepEqual(sealedBack.findings, ["x"], "findings must not be normalized");
  assert.equal(sealedBack.evidence, "e-1", "evidence must survive");
  assert.equal(
    validateRecordedCountersignOutput({ status: "converged", note: "n" }).status,
    "converged",
  );
  assert.equal(
    validateRecordedCountersignOutput({
      status: "escalate",
      decisionGate: { question: "q", options: ["a"] },
    }).status,
    "escalate",
  );
  assert.throws(() => validateRecordedCountersignOutput({ status: "maybe" }));
  assert.throws(() => validateRecordedCountersignOutput(null));
});

test("review officers expose one shared output tool and receipt schema", () => {
  assert.deepEqual(
    [COUNTERSIGN_OUTPUT_TOOL_NAME, JUDGE_OUTPUT_TOOL_NAME, NOTARY_OUTPUT_TOOL_NAME, AUDITOR_OUTPUT_TOOL_NAME, INSPECTOR_OUTPUT_TOOL_NAME],
    [REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME],
  );
  assert.ok([countersignVerdictSchema, judgeVerdictSchema, notaryOutputSchema, auditorOutputSchema, inspectorOutputSchema].every((schema) => schema === reviewSubmissionSchema));
  const branches = (reviewSubmissionSchema as { anyOf?: Array<{
    properties?: Record<string, { description?: unknown }>;
    required?: string[];
    additionalProperties?: unknown;
  }> }).anyOf ?? [];
  const shape = branches.find((branch) => branch.required?.includes("status"));
  assert.ok(shape);
  assert.deepEqual(shape.required ?? [], ["status"]);
  assert.equal(shape.additionalProperties, true);
  assert.equal(typeof shape.properties?.status?.description, "string");
  assert.ok(shape.properties?.status?.description !== "");
  for (const word of REVIEW_QUEUE_WORDS) {
    assert.equal(Value.Check(reviewSubmissionSchema, { status: word, extra: true }), true, word);
  }
  assert.equal(Value.Check(reviewSubmissionSchema, { note: "missing status" }), false);
  assert.equal(Value.Check(reviewSubmissionSchema, { status: "not-a-status" }), false);
  assert.equal(Value.Check(reviewSubmissionSchema, { infrastructureFailure: { diagnostic: "disk full" } }), true);
  for (const field of ["fix", "classes", "decisionGate"]) {
    assert.equal(typeof shape.properties?.[field]?.description, "string");
    assert.equal(shape.required?.includes(field) ?? false, false);
  }
  for (const field of ["fix", "classes", "decisionGate"]) {
    assert.equal(Value.Check(reviewSubmissionSchema, { status: "continue", [field]: "readable submission" }), true);
  }
  const closed = closeJsonSchemaForCodex(terminatingToolJsonSchema(reviewSubmissionSchema)) as {
    anyOf?: Array<{ required?: string[]; properties?: Record<string, unknown> }>;
  };
  const closedVerdict = closed.anyOf?.find((branch) => branch.required?.includes("status"));
  const closedFailure = closed.anyOf?.find((branch) => branch.required?.includes("infrastructureFailure") && !branch.required.includes("status"));
  assert.ok(closedVerdict);
  assert.ok(closedFailure);
  assert.equal(JSON.stringify(closedVerdict.properties?.status).includes('"null"'), false);
  for (const word of REVIEW_QUEUE_WORDS) {
    assert.equal(JSON.stringify(closedVerdict.properties?.status).includes(word), true);
  }
});

test("Countersign runtime registers output tool and injects soul without ticket body preload", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.roleHost as never,
    { loadSoul: async () => "COUNTERSIGN LAW" },
  );
  await runtime.activate();
  assert.ok(h.tools.has(COUNTERSIGN_OUTPUT_TOOL_NAME));
  assert.ok(h.beforeStart());

  const prompted = h.beforeStart()!({ systemPrompt: "BASE" }) as {
    systemPrompt: string;
  };
  // Soul-only injection: no ticket body preload key (materials flow via transport prompt).
  assert.ok(prompted.systemPrompt.length > "BASE".length);
});

test("Countersign runtime refuses empty soul", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.roleHost as never,
    { loadSoul: async () => "   " },
  );
  await assert.rejects(runtime.activate());
});

test("Countersign execute accepts as-is and terminates — sole-final barrier is ledger-owned", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.roleHost as never,
    { loadSoul: async () => "LAW" },
  );
  await runtime.activate();
  const tool = h.tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const declared = tool.parameters as { anyOf?: Array<{ required?: readonly string[] }> };
  assert.equal(declared.anyOf?.some((branch) => branch.required?.includes("status")), true);

  const result = await tool.execute(
    "one",
    { status: "continue", findings: ["x"] },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.terminate, true);
  assert.equal(
    (result.details as { status: string }).status,
    "continue",
  );
  assert.deepEqual(result.content, []);
});
