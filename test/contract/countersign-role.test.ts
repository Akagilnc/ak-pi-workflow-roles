import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

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
import {
  REVIEW_QUEUE_WORDS,
  REVIEW_SUBMISSION_OUTPUT_TOOL_NAME,
  notaryReviewSubmissionSchema,
  inspectorSubmissionSchema,
  reviewSubmissionSchema,
} from "../../src/review-submission.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";
import { roleSubmissionDeclaration } from "../../src/role-submission-declarations.ts";

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

test("review officers share the output tool; only notary requires clauses", () => {
  assert.deepEqual(
    [COUNTERSIGN_OUTPUT_TOOL_NAME, JUDGE_OUTPUT_TOOL_NAME, NOTARY_OUTPUT_TOOL_NAME, AUDITOR_OUTPUT_TOOL_NAME, INSPECTOR_OUTPUT_TOOL_NAME],
    [REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME],
  );
  assert.equal(countersignVerdictSchema, reviewSubmissionSchema);
  assert.equal(notaryOutputSchema, notaryReviewSubmissionSchema);
  assert.ok([judgeVerdictSchema, auditorOutputSchema].every((schema) => schema === reviewSubmissionSchema));
  assert.equal(inspectorOutputSchema, inspectorSubmissionSchema);
  assert.equal(roleSubmissionDeclaration("inspector").parameters, inspectorSubmissionSchema);
  assert.equal(roleSubmissionDeclaration("countersign").parameters, reviewSubmissionSchema);
  assert.equal(Object.hasOwn(countersignVerdictSchema.properties, "clauses"), false);
  assert.equal(roleSubmissionDeclaration("notary").parameters, notaryReviewSubmissionSchema);
  for (const word of REVIEW_QUEUE_WORDS) {
    assert.equal(Value.Check(reviewSubmissionSchema, { status: word, extra: true }), true, word);
    assert.equal(
      Value.Check(notaryReviewSubmissionSchema, {
        status: word,
        clauses: [{ clause: "c", ownerUuid: null, derivation: "无原话" }],
      }),
      true,
      word,
    );
  }
  assert.equal(Value.Check(reviewSubmissionSchema, { status: "not-a-status" }), false);
  assert.equal(Value.Check(reviewSubmissionSchema, {}), false);
  // Only the notary generation declaration requires clauses.
  assert.equal(Value.Check(notaryReviewSubmissionSchema, { status: "converged" }), false);
  assert.equal(
    Value.Check(notaryReviewSubmissionSchema, {
      status: "converged",
      clauses: [{ clause: "c", ownerUuid: "u", derivation: "d" }],
      extra: true,
    }),
    true,
  );
  // Other review seats do not require clauses.
  assert.equal(Value.Check(reviewSubmissionSchema, { status: "converged" }), true);
  // The inspector's generation declaration requires the whole-ticket complexity rows: clause text plus hits, empty when none.
  assert.equal(Value.Check(inspectorSubmissionSchema, { status: "converged" }), false);
  assert.equal(
    Value.Check(inspectorSubmissionSchema, {
      status: "converged",
      ticketComplexity: [{ class: "同一业务规则只保留一个权威实现", hits: [] }],
    }),
    true,
  );
  assert.equal(
    Value.Check(inspectorSubmissionSchema, {
      status: "continue",
      ticketComplexity: [{ class: "同一业务规则只保留一个权威实现", hits: null }],
    }),
    false,
  );
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

  const withFindings = await tool.execute(
    "one",
    { status: "continue", findings: ["x"] },
    undefined,
    undefined,
    {},
  );
  assert.equal(withFindings.terminate, true);
  assert.equal(
    (withFindings.details as { status: string }).status,
    "continue",
  );
  assert.deepEqual(withFindings.content, []);

  // The common review face needs no clause table.
  const withoutClauses = await tool.execute(
    "no-clauses",
    { status: "converged" },
    undefined,
    undefined,
    {},
  );
  assert.equal(withoutClauses.terminate, true);
  assert.deepEqual(withoutClauses.details, { status: "converged" });

  // A resumed pre-change session can still submit the old table unchanged.
  const legacy = {
    status: "converged",
    clauses: [{ clause: "c", ownerUuid: null, derivation: "d" }],
  };
  const withLegacyClauses = await tool.execute("legacy", legacy, undefined, undefined, {});
  assert.equal(withLegacyClauses.terminate, true);
  assert.deepEqual(withLegacyClauses.details, legacy);
});
