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
import type { ComplianceNoReceipt } from "../../src/compliance-transport.ts";
import { runComplianceAudit } from "../../src/compliance-transport.ts";
import { GatekeeperDecisionError } from "../../src/submission-errors.ts";
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
  let bounceCalls = 0;
  const result = await disposeComplianceDecision(decision, {
    pass: () => { passCalls += 1; throw new Error("pass branch used"); },
    bounce: () => { bounceCalls += 1; throw new Error("bounce branch used"); },
    escalate: (value) => value,
  });
  assert.equal(passCalls, 0);
  assert.equal(bounceCalls, 0);
  assert.equal(result.terminate, true);
  assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
  assert.deepEqual((result.details.audit as { conflicts?: unknown }).conflicts, decision.conflicts);
  assert.deepEqual(
    (result.details.audit as { auditDecisionGate?: unknown }).auditDecisionGate,
    decision.decisionGate,
  );
  assert.equal(result.content[0].text, JSON.stringify(decision));
  assert.doesNotMatch(result.content[0].text, /accepted/i);
  assert.equal(isAuditEscalationResult(result.details), true);
  // #836: status/allowlist rejection deleted — original payload is accepted as details.
  assert.deepEqual(
    validateAcceptedDetails(JUDGE_OUTPUT_TOOL_NAME, result.details),
    result.details,
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
  const delivered = {
    judgeStatus: "converged" as const,
    note: "keep-me",
    reason: "role reason",
    officer: "role officer",
    findings: ["role finding"],
  };
  const result = await disposeComplianceDecision(
    decision,
    {
      pass: () => {
        throw new Error("pass");
      },
      bounce: () => {
        throw new Error("bounce");
      },
      escalate: (value) => value,
    },
    delivered,
  );
  assert.equal(result.details.kind, AUDIT_ESCALATION_KIND);
  assert.deepEqual(result.details.receipt, delivered);
  assert.deepEqual((result.details.audit as { conflicts?: unknown }).conflicts, ["conflict"]);
  assert.equal(result.content[0]?.text, JSON.stringify(delivered));
  const stripped = projectAuditEscalation(decision).details;
  assert.equal(stripped.receipt, undefined);

  const officer = projectAuditEscalation(
    { status: "escalate", officer: "notary" },
    delivered,
  ).details;
  assert.deepEqual(officer.receipt, delivered);
  assert.equal((officer.audit as { officer?: unknown }).officer, "notary");
  assert.equal((officer.receipt as { officer?: unknown }).officer, "role officer");
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
      bounce: () => {
        throw new Error("bounce");
      },
      escalate: (value) => value,
    },
    delivered,
  );
  const details = result.details;
  assert.equal(details.kind, AUDIT_ESCALATION_KIND);
  assert.deepEqual(details.receipt, delivered);
  assert.deepEqual((details.receipt as { decisionGate?: unknown }).decisionGate, roleGate);
  assert.deepEqual((details.audit as { conflicts?: unknown }).conflicts, decision.conflicts);
  assert.deepEqual((details.audit as { auditDecisionGate?: unknown }).auditDecisionGate, auditGate);
  assert.equal(result.content[0]?.text, JSON.stringify(delivered));
  const launder = await disposeComplianceDecision(
    decision,
    {
      pass: () => {
        throw new Error("pass");
      },
      bounce: () => {
        throw new Error("bounce");
      },
      escalate: (value) => value,
    },
    { kind: "not-escalation", decisionGate: roleGate },
  );
  assert.equal(launder.details.kind, AUDIT_ESCALATION_KIND);
  assert.equal((launder.details.receipt as { kind?: unknown }).kind, "not-escalation");
});

test("no-receipt uses its own projection leg instead of collapsing into pass", async () => {
  const decision = {
    status: "no-receipt" as const,
    acceptedReceipt: false as const,
    terminalToolCalled: true,
    rejectedReceipts: [{ reason: "未观察到 commit", diagnosticAvailable: true }],
    deliveryTurns: 2 as const,
    sessionCompletion: "settled-without-accepted-receipt" as const,
    runPointer: "/run",
    attemptPointer: "attempt-1",
  };
  let passCalls = 0;
  const result = await disposeComplianceDecision<{
    parent: string;
    auditNoReceipt: ComplianceNoReceipt;
  }>(decision, {
    pass: () => { passCalls += 1; throw new Error("ordinary pass used"); },
    noReceipt: (facts) => ({ parent: "accepted", auditNoReceipt: facts }),
    bounce: () => { throw new Error("bounce used"); },
    escalate: () => { throw new Error("escalate used"); },
  });
  assert.equal(passCalls, 0);
  assert.equal(result.parent, "accepted");
  assert.equal(result.auditNoReceipt.acceptedReceipt, false);
  assert.equal(result.auditNoReceipt.deliveryTurns, 2);
  assert.equal(result.auditNoReceipt.rejectedReceipts[0]?.reason, "未观察到 commit");
  assert.equal(result.auditNoReceipt.attemptPointer, "attempt-1");
});

test("runComplianceAudit keeps host failure beside recorded auditor payloads", async () => {
  const bounce = { status: "bounce", violations: ["keep-me"] };
  const decision = await runComplianceAudit({
    subject: "doctor",
    context: { cwd: process.cwd() } as never,
    runDirectory: "/tmp/parent-run",
    summonAuditor: async () => ({
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "auditor",
          cause: "output",
          diagnostic: "This operation was aborted",
          decisiveFacts: { cause: "output" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "auditor-run",
        submissions: [bounce],
      },
    }),
  });
  assert.equal(decision.status, "transport_failure");
  if (decision.status === "transport_failure") {
    assert.match(decision.diagnostic, /This operation was aborted/);
    assert.deepEqual(decision.submissions, [bounce]);
  }
  await assert.rejects(
    disposeComplianceDecision(decision, {
      pass: () => { throw new Error("pass"); },
      bounce: () => { throw new Error("bounce"); },
      escalate: () => { throw new Error("escalate"); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GatekeeperDecisionError);
      assert.equal(error.result.status, "transport_failure");
      if (error.result.status === "transport_failure") {
        assert.match(error.result.reason, /This operation was aborted/);
        assert.deepEqual(error.result.submission, [bounce]);
      }
      return true;
    },
  );
});
