import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_ESCALATION_KIND,
  buildAuditEscalationResult,
  disposeComplianceDecision,
  isAuditEscalationProjection,
  isAuditEscalationResult,
  projectAuditEscalation,
} from "../../src/audit-escalation.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  AcceptedDetailsContractError,
  validateAcceptedDetails,
} from "../../src/package-contracts/terminating-tools.ts";

const escalationArguments = {
  status: "escalate",
  violations: [],
  conflicts: ["Soul authority and controlling authority disagree"],
  decisionGate: {
    question: "Which authority governs this submission?",
    options: ["Use the Soul", "Use the controlling authority"],
  },
};

test("escalation projects one terminating human decision and is not an accepted Receipt", async () => {
  const decision = {
    status: "escalate" as const,
    conflicts: escalationArguments.conflicts,
    decisionGate: escalationArguments.decisionGate,
  };
  let passCalls = 0;
  let reviseCalls = 0;
  const result = await disposeComplianceDecision(decision, {
    pass: () => { passCalls += 1; throw new Error("pass branch used"); },
    revise: () => { reviseCalls += 1; throw new Error("revise branch used"); },
    escalate: (value) => value,
    auditIncomplete: () => { throw new Error("audit-incomplete branch used"); },
  });
  assert.equal(passCalls, 0);
  assert.equal(reviseCalls, 0);
  assert.equal(result.terminate, true);
  assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
  assert.deepEqual(result.details.conflicts, decision.conflicts);
  assert.deepEqual(result.details.auditDecisionGate, decision.decisionGate);
  assert.match(result.content[0].text, /Human decision required/);
  // Human text reads the audit-owned gate only — question + every option present.
  assert.ok(result.content[0].text.includes(decision.decisionGate.question));
  for (const option of decision.decisionGate.options) {
    assert.ok(
      result.content[0].text.includes(option),
      `human text must carry audit option: ${option}`,
    );
  }
  assert.doesNotMatch(result.content[0].text, /accepted/i);
  assert.equal(isAuditEscalationResult(result.details), true);
  assert.throws(
    () => validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, result.details),
    /not an accepted role receipt/,
  );
  assert.deepEqual(projectAuditEscalation(decision).details, result.details);
});

test("live audit projection requires the private identity, not a copied structural brand", () => {
  const genuine = buildAuditEscalationResult({
    status: "escalate",
    conflicts: ["c"],
    decisionGate: { question: "Q", options: ["A"] },
  });
  assert.equal(isAuditEscalationProjection(genuine), true);

  const separatelyBuiltBrand = Object.freeze(Object.create(null));
  const forged = { ...genuine };
  Object.setPrototypeOf(forged, separatelyBuiltBrand);
  assert.equal(isAuditEscalationProjection(forged), false);
});

test("isAuditEscalationResult recognises by kind only — mixed elements and empty gate stay lawful", () => {
  const shapes = [
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["ok", 4],
      decisionGate: { question: "Q", options: ["A"] },
    },
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["c"],
      decisionGate: { question: "Q", options: ["A", 7] },
    },
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["only"],
      decisionGate: { question: "", options: [] },
    },
    {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: [],
      decisionGate: { question: "", options: [] },
    },
  ];
  for (const shape of shapes) {
    assert.equal(isAuditEscalationResult(shape), true, JSON.stringify(shape));
  }
  assert.equal(isAuditEscalationResult({ kind: "other" }), false);
  assert.equal(isAuditEscalationResult({ conflicts: ["c"] }), false);
});

test("disposeComplianceDecision preserves delivered role output on escalate face", async () => {
  const decision = {
    status: "escalate" as const,
    conflicts: ["conflict"],
    decisionGate: { question: "", options: [] as unknown[] },
  };
  const delivered = { judgeStatus: "converged" as const, note: "keep-me" };
  const result = await disposeComplianceDecision(
    decision,
    {
      pass: () => {
        throw new Error("pass");
      },
      revise: () => {
        throw new Error("revise");
      },
      escalate: (value) => value,
    },
    delivered,
  );
  assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
  assert.equal(result.details.judgeStatus, "converged");
  assert.equal(result.details.note, "keep-me");
  assert.deepEqual(result.details.conflicts, ["conflict"]);
  // Audit gate always lives at auditDecisionGate — one fixed home.
  assert.deepEqual(result.details.auditDecisionGate, decision.decisionGate);
  // Role brought no decisionGate — that key stays absent (not filled by audit).
  assert.equal(result.details.decisionGate, undefined);
  // Without delivered output, verdict fields are absent (negative control).
  const stripped = projectAuditEscalation(decision).details;
  assert.equal(stripped.note, undefined);
});

test("escalate face keeps role decisionGate and audit gate side by side", async () => {
  const roleGate = {
    question: "删除还是保留 600s 墙钟？",
    options: ["A 全删", "B 保留并指定 owner"],
  };
  const auditGate = {
    question: "AUDIT Q?",
    options: ["AUDIT A", "AUDIT B"],
  };
  const decision = {
    status: "escalate" as const,
    conflicts: ["审刑院记账位不可读"],
    decisionGate: auditGate,
  };
  const delivered = {
    judgeStatus: "escalate" as const,
    reasoning: "need owner choice",
    decisionGate: roleGate,
    classes: [] as unknown[],
  };
  const result = await disposeComplianceDecision(
    decision,
    {
      pass: () => {
        throw new Error("pass");
      },
      revise: () => {
        throw new Error("revise");
      },
      escalate: (value) => value,
    },
    delivered,
  );
  const details = result.details;
  assert.equal(details.kind, AUDIT_ESCALATION_KIND);
  assert.equal(details.judgeStatus, "escalate");
  assert.equal(details.reasoning, "need owner choice");
  assert.deepEqual(details.classes, []);
  // Role's options survive in full, in order — not eaten by the audit gate.
  assert.deepEqual(details.decisionGate, roleGate);
  assert.deepEqual(details.conflicts, decision.conflicts);
  // Audit gate has one fixed home beside the role gate (neither folded).
  assert.deepEqual(details.auditDecisionGate, auditGate);
  // Human text carries the audit gate; role question is not passed off as audit's.
  const face = result.content[0].text;
  assert.ok(face.includes(auditGate.question), "audit question must appear in human text");
  for (const option of auditGate.options) {
    assert.ok(face.includes(option), `audit option must appear in human text: ${option}`);
  }
  assert.equal(
    face.includes(`Question: ${roleGate.question}`),
    false,
    "role question must not be presented as the audit Question",
  );
  // Malformed role decisionGate must not throw (reads audit home only).
  for (const badGate of ["oops", { question: "q" }] as const) {
    const resilient = projectAuditEscalation(decision, {
      judgeStatus: "escalate",
      decisionGate: badGate,
    });
    assert.equal(resilient.details.kind, AUDIT_ESCALATION_KIND);
    assert.deepEqual(resilient.details.auditDecisionGate, auditGate);
    assert.equal(resilient.details.decisionGate, badGate);
    assert.ok(resilient.content[0].text.includes(auditGate.question));
  }
  // kind cannot be laundered by a role field of the same name.
  const launder = await disposeComplianceDecision(
    decision,
    {
      pass: () => {
        throw new Error("pass");
      },
      revise: () => {
        throw new Error("revise");
      },
      escalate: (value) => value,
    },
    { kind: "not-escalation", decisionGate: roleGate },
  );
  assert.equal(launder.details.kind, AUDIT_ESCALATION_KIND);
});

test("audit-incomplete crosses disposition without entering a role decision handler", async () => {
  const decision = {
    status: "audit-incomplete" as const,
    observation: { kind: "non-object-arguments" as const, type: "array" as const },
    candidate: ["provider candidate"],
  };
  let passCalls = 0;
  let reviseCalls = 0;
  let escalateCalls = 0;
  let auditIncompleteCalls = 0;
  const result = await disposeComplianceDecision<import("../../src/audit-escalation.ts").AuditIncompleteToolResult>(decision, {
    pass: () => { passCalls += 1; throw new Error("pass branch used"); },
    revise: () => { reviseCalls += 1; throw new Error("revise branch used"); },
    escalate: () => { escalateCalls += 1; throw new Error("escalate branch used"); },
    auditIncomplete: (value) => { auditIncompleteCalls += 1; return value; },
  });
  assert.equal(passCalls, 0);
  assert.equal(reviseCalls, 0);
  assert.equal(escalateCalls, 0);
  assert.equal(auditIncompleteCalls, 1);
  assert.equal(result.terminate, true);
  assert.equal(result.details.status, "audit-incomplete");
  assert.deepEqual(result.details.observation, decision.observation);
  assert.deepEqual(result.details.candidate, decision.candidate);
  assert.throws(
    () => validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, result.details),
    AcceptedDetailsContractError,
  );
});
