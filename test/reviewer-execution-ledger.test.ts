import assert from "node:assert/strict";
import test from "node:test";

import {
  createReviewerExecutionLedger,
  type ReviewerAgentPersistedEvidence,
  type ReviewerAgentResult,
  type ReviewerUsage,
} from "../src/reviewer-execution-ledger.ts";
import type { CanonicalSkillEvidence } from "../src/canonical-skill-binding.ts";

type ReviewerSkillEvidence = CanonicalSkillEvidence<"code-review">;

const skill = (): ReviewerSkillEvidence => ({
  name: "code-review",
  location: "/canonical/code-review/SKILL.md",
  content: "canonical method",
  userMessage: "review the fixed point",
});

const args = (description: string) => ({
  subagent_type: "general-purpose",
  description,
  prompt: `${description} prompt`,
});

const assistant = (
  entryId: string,
  calls: Array<{ id: string; arguments: unknown }>,
): ReviewerAgentPersistedEvidence => ({ kind: "assistant", entryId, calls });

const success = (report = "substantive report"): ReviewerAgentResult => ({
  report,
  workspaceDisposition: "deleted",
});

function beginOne(id = "axis", entryId = "entry") {
  const ledger = createReviewerExecutionLedger();
  ledger.recordSkillExpansion(skill());
  ledger.beginAgentCall(id, args(id), assistant(entryId, [
    { id, arguments: args(id) },
  ]));
  return ledger;
}

test("one assistant entry is one ordered batch and later entries remain distinct", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.recordSkillExpansion(skill());
  const shared = assistant("entry-1", [
    { id: "standards", arguments: args("standards") },
    { id: "spec", arguments: args("spec") },
  ]);

  ledger.beginAgentCall("standards", args("standards"), shared);
  ledger.beginAgentCall("spec", args("spec"), shared);
  ledger.completeAgentCall("standards", success("standards report"));
  ledger.completeAgentCall("spec", {
    ...success("spec report"),
    targetSnapshot: {
      repositoryRoot: "/repo",
      targetHead: "first-snapshot",
      refs: { "refs/heads/main": "first-snapshot" },
    },
  });
  ledger.beginAgentCall("followup", args("followup"), assistant("entry-2", [
    { id: "followup", arguments: args("followup") },
  ]));
  ledger.completeAgentCall("followup", {
    ...success("followup report"),
    targetSnapshot: {
      repositoryRoot: "/repo",
      targetHead: "later-snapshot",
      refs: { "refs/heads/main": "later-snapshot" },
    },
  });

  const record = ledger.recordForAudit("completed");
  assert.equal(record.targetSnapshot?.targetHead, "first-snapshot");
  assert.deepEqual(
    record.agentAttempts.map((attempt) => attempt.workspaceDisposition),
    ["deleted", "deleted", "deleted"],
  );
  assert.deepEqual(record.agentInvocationBatches, [
    {
      assistantSessionEntryId: "entry-1",
      executionMode: "parallel",
      agentToolCallIds: ["standards", "spec"],
    },
    {
      assistantSessionEntryId: "entry-2",
      executionMode: "parallel",
      agentToolCallIds: ["followup"],
    },
  ]);
});

test("all invalid provenance is rejected before a child can start", () => {
  const scenarios: Array<[string, string, ReviewerAgentPersistedEvidence, RegExp]> = [
    ["duplicate-current", "dup", assistant("dup-entry", [
      { id: "dup", arguments: args("first") },
      { id: "dup", arguments: args("second") },
    ]), /does not occur exactly once|not unique/],
    ["current-missing", "missing", assistant("missing-entry", [
      { id: "other", arguments: args("other") },
    ]), /does not occur exactly once/],
    ["unavailable", "lost", { kind: "unavailable" }, /not an assistant message/],
    ["non-assistant", "user-leaf", { kind: "non-assistant" }, /not an assistant message/],
  ];

  for (const [, id, evidence, diagnostic] of scenarios) {
    const ledger = createReviewerExecutionLedger();
    let childStarts = 0;
    assert.throws(() => {
      ledger.beginAgentCall(id, args(id), evidence);
      childStarts += 1;
    }, diagnostic);
    assert.equal(childStarts, 0);
    assert.throws(() => ledger.recordForAudit("refused"), /infrastructure previously failed/);
  }

  const across = createReviewerExecutionLedger();
  across.beginAgentCall("same", args("same"), assistant("first", [
    { id: "same", arguments: args("same") },
  ]));
  across.completeAgentCall("same", success());
  let crossEntryError: unknown;
  assert.throws(
    () => {
      try {
        across.beginAgentCall("same", args("same"), assistant("second", [
          { id: "same", arguments: args("same") },
        ]));
      } catch (error) {
        crossEntryError = error;
        throw error;
      }
    },
    /not unique|more than one persisted assistant entry/,
  );
  assert.equal(
    (crossEntryError as { reviewerAgentAttempt?: unknown }).reviewerAgentAttempt,
    undefined,
    "later conflicting provenance does not fabricate a failed snapshot for a successful attempt",
  );
  assert.throws(
    () => across.failAgentCall("same", new Error("must not overwrite")),
    /already successful/,
  );
  assert.throws(
    () => across.recordForAudit("refused"),
    /infrastructure previously failed/,
  );

  const conflict = createReviewerExecutionLedger();
  conflict.beginAgentCall("axis", args("axis"), assistant("entry", [
    { id: "axis", arguments: args("axis") },
  ]));
  assert.throws(
    () => conflict.beginAgentCall("axis", args("axis"), assistant("entry", [
      { id: "axis", arguments: args("axis") },
      { id: "new", arguments: args("new") },
    ])),
    /conflicting batch evidence/,
  );
});

test("runtime Agent arguments must match first and repeated persisted observations", () => {
  for (const observation of ["first", "repeated"] as const) {
    const ledger = createReviewerExecutionLedger();
    const persisted = assistant("entry", [{
      id: "axis",
      arguments: args("persisted"),
    }]);
    if (observation === "repeated") {
      ledger.beginAgentCall("axis", args("persisted"), persisted);
    }

    let failure: unknown;
    assert.throws(() => {
      try {
        ledger.beginAgentCall("axis", args("runtime"), persisted);
      } catch (error) {
        failure = error;
        throw error;
      }
    }, /runtime arguments.*disagree.*persisted/i);
    assert.deepEqual(
      (failure as { reviewerAgentAttempt?: unknown }).reviewerAgentAttempt,
      {
        id: "axis",
        description: observation === "first" ? "runtime" : "persisted",
        prompt: observation === "first"
          ? "runtime prompt"
          : "persisted prompt",
        status: "failed",
        diagnostics: (failure as Error).message,
      },
    );
    assert.throws(
      () => ledger.recordForAudit("refused"),
      /infrastructure previously failed.*runtime arguments.*disagree/i,
    );
  }
});

test("identical Pi start and execute observations are idempotent", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.recordSkillExpansion(skill());
  const evidence = assistant("entry", [{ id: "axis", arguments: args("axis") }]);
  ledger.beginAgentCall("axis", args("axis"), evidence);
  ledger.beginAgentCall("axis", args("axis"), evidence);
  ledger.completeAgentCall("axis", success());

  const record = ledger.recordForAudit("completed");
  assert.equal(record.agentAttempts.length, 1);
  assert.equal(record.agentInvocationBatches.length, 1);
});

test("attempts have exactly one legal running to terminal lifecycle", () => {
  const successful = beginOne();
  const attempt = successful.completeAgentCall("axis", success("done"));
  assert.equal(attempt.status, "successful");
  assert.ok(Object.isFrozen(attempt));
  assert.throws(() => successful.completeAgentCall("axis", success("again")), /running.*successful|already.*successful/i);
  assert.throws(() => successful.failAgentCall("axis", new Error("late failure")), /running.*successful|already.*successful/i);
  let successfulReplay: unknown;
  assert.throws(() => {
    try {
      successful.beginAgentCall("axis", args("axis"), assistant("entry", [
        { id: "axis", arguments: args("axis") },
      ]));
    } catch (error) {
      successfulReplay = error;
      throw error;
    }
  }, /lifecycle.*already successful/i);
  assert.equal(
    (successfulReplay as { reviewerAgentAttempt?: unknown }).reviewerAgentAttempt,
    undefined,
  );
  assert.equal(attempt.status, "successful");
  assert.equal(attempt.report, "done");
  assert.throws(() => successful.recordForAudit("refused"), /infrastructure previously failed.*already successful/i);

  const failed = beginOne();
  const failure = failed.failAgentCall("axis", new Error("child failed"));
  assert.match(failure.message, /child failed/);
  assert.equal(failure.reviewerAgentAttempt.status, "failed");
  assert.throws(() => failed.failAgentCall("axis", new Error("again")), /running.*failed|already.*failed/i);
  let failedReplay: unknown;
  assert.throws(() => {
    try {
      failed.beginAgentCall("axis", args("axis"), assistant("entry", [
        { id: "axis", arguments: args("axis") },
      ]));
    } catch (error) {
      failedReplay = error;
      throw error;
    }
  }, /lifecycle.*already failed/i);
  assert.equal(
    (failedReplay as { reviewerAgentAttempt?: unknown }).reviewerAgentAttempt,
    undefined,
  );
  assert.equal(failure.reviewerAgentAttempt.status, "failed");
  assert.equal(failure.reviewerAgentAttempt.diagnostics, "child failed");

  const nonError = beginOne("non-error");
  const wrapped = nonError.failAgentCall("non-error", "child string failure");
  assert.ok(wrapped instanceof Error);
  assert.notEqual(wrapped, "child string failure");
  assert.equal(wrapped.message, "child string failure");

  const blank = beginOne();
  assert.throws(() => blank.completeAgentCall("axis", success("   ")), /blank child report/);
});

test("completion proof rejects no calls, running, ordinary failed, and orphan attempts", () => {
  const noCalls = createReviewerExecutionLedger();
  noCalls.recordSkillExpansion(skill());
  assert.throws(() => noCalls.recordForAudit("completed"), /at least one successful Agent call/);

  const running = beginOne();
  assert.throws(() => running.recordForAudit("completed"), /running attempts: axis/);

  const failed = beginOne();
  failed.rejectAgentCall("axis", "schema rejected");
  assert.throws(() => failed.recordForAudit("completed"), /failed attempts: axis: schema rejected/);

  const orphan = createReviewerExecutionLedger();
  orphan.recordSkillExpansion(skill());
  orphan.rejectAgentCall("orphan", "schema rejected before start");
  assert.throws(() => orphan.recordForAudit("completed"), /extra attempts: orphan/);

  const duplicate = createReviewerExecutionLedger();
  assert.throws(() => duplicate.beginAgentCall("dup", args("dup"), assistant("entry", [
    { id: "dup", arguments: args("dup") },
    { id: "dup", arguments: args("dup") },
  ])), /does not occur exactly once|not unique/);
});

test("successful evidence is defensively owned and each audit record is deeply immutable", () => {
  const ledger = createReviewerExecutionLedger();
  const callerSkill = skill();
  const persistedArgs = args("persisted");
  const calls = [{ id: "axis", arguments: persistedArgs }];
  const evidence = assistant("entry", calls);
  const resultUsage: ReviewerUsage = {
    input: 3,
    output: 5,
    cacheRead: 7,
    cacheWrite: 11,
    cacheWrite1h: 2,
    reasoning: 4,
    totalTokens: 26,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
  const refs = { "refs/heads/main": "abc123" };
  const disposition = { retained: "/tmp/review-workspace" };
  const result: ReviewerAgentResult = {
    report: "original report",
    usage: resultUsage,
    targetSnapshot: {
      repositoryRoot: "/repo",
      targetHead: "abc123",
      refs,
    },
    workspaceDisposition: disposition,
  };

  ledger.recordSkillExpansion(callerSkill);
  ledger.recordSkillExpansion({ ...callerSkill });
  ledger.beginAgentCall("axis", args("persisted"), evidence);
  const details = ledger.completeAgentCall("axis", result);

  (callerSkill as { location: string }).location = "/mutated";
  persistedArgs.description = "mutated persisted description";
  calls[0]!.id = "mutated-id";
  result.report = "mutated report";
  resultUsage.input = 999;
  resultUsage.cacheWrite1h = 999;
  resultUsage.reasoning = 999;
  resultUsage.cost.total = 999;
  refs["refs/heads/main"] = "mutated-ref";
  disposition.retained = "/mutated-workspace";

  assert.equal(details.report, "original report");
  assert.equal(details.usage?.input, 3);
  assert.equal(details.usage?.cacheWrite1h, 2);
  assert.equal(details.usage?.reasoning, 4);
  assert.equal(details.usage?.cost.total, 10);
  assert.equal(details.targetSnapshot?.refs["refs/heads/main"], "abc123");
  assert.deepEqual(details.workspaceDisposition, { retained: "/tmp/review-workspace" });
  assert.throws(() => ledger.recordSkillExpansion({ ...skill(), content: "different" }), /conflicting.*Skill|already recorded/i);

  const first = ledger.recordForAudit("completed");
  assert.equal(first.targetSnapshot?.targetHead, "abc123");
  assert.throws(() => { (first as any).agentAttempts = []; }, TypeError);
  assert.throws(() => { (first.agentAttempts[0]!.usage!.cost as any).total = -1; }, TypeError);
  assert.throws(() => { (first.agentAttempts[0]!.targetSnapshot!.refs as any)["refs/heads/main"] = "evil"; }, TypeError);
  assert.throws(() => { (first.agentAttempts[0]!.workspaceDisposition as any).retained = "evil"; }, TypeError);
  assert.equal(first.agentAttempts[0]?.report, "original report");
  assert.equal(first.agentAttempts[0]?.usage?.cacheWrite1h, 2);
  assert.equal(first.agentAttempts[0]?.usage?.reasoning, 4);
  assert.equal(first.agentAttempts[0]?.usage?.cost.total, 10);
  assert.equal(first.agentAttempts[0]?.targetSnapshot?.refs["refs/heads/main"], "abc123");

  const second = ledger.recordForAudit("completed");
  assert.notEqual(second, first);
  assert.notEqual(second.agentAttempts, first.agentAttempts);
  assert.equal(second.skillEvidence?.location, "/canonical/code-review/SKILL.md");
  assert.equal(second.agentAttempts[0]?.report, "original report");
  assert.equal(second.agentAttempts[0]?.usage?.cost.total, 10);
  assert.equal(second.agentAttempts[0]?.targetSnapshot?.refs["refs/heads/main"], "abc123");
});

test("fatal failure diagnostics and evidence are detached and block both receipt statuses", () => {
  const ledger = beginOne();
  const refs = { "refs/heads/main": "original" };
  const retained = { retained: "/original" };
  const error = Object.assign(new Error("provider unavailable"), {
    targetSnapshot: { repositoryRoot: "/repo", targetHead: "head", refs },
    workspaceDisposition: retained,
  });
  const returned = ledger.failAgentCall("axis", error);
  assert.equal(returned, error);
  refs["refs/heads/main"] = "mutated";
  retained.retained = "/mutated";
  (error.targetSnapshot as any).targetHead = "mutated";

  assert.equal(returned.reviewerAgentAttempt.diagnostics, "provider unavailable");
  assert.equal(returned.reviewerAgentAttempt.targetSnapshot?.targetHead, "head");
  assert.equal(returned.reviewerAgentAttempt.targetSnapshot?.refs["refs/heads/main"], "original");
  assert.deepEqual(returned.reviewerAgentAttempt.workspaceDisposition, { retained: "/original" });
  assert.throws(() => { (returned.reviewerAgentAttempt.targetSnapshot!.refs as any)["refs/heads/main"] = "evil"; }, TypeError);
  assert.throws(() => ledger.recordForAudit("completed"), /infrastructure previously failed: provider unavailable/);
  assert.throws(() => ledger.recordForAudit("refused"), /infrastructure previously failed: provider unavailable/);

  for (const status of ["completed", "refused"] as const) {
    const infrastructure = createReviewerExecutionLedger();
    const original = new Error("cleanup failed");
    assert.equal(infrastructure.recordInfrastructureFailure(original), original);
    assert.throws(() => infrastructure.recordForAudit(status), /infrastructure previously failed: cleanup failed/);
  }

  const stringLedger = createReviewerExecutionLedger();
  const stringFailure = "audit string failure";
  assert.equal(
    stringLedger.recordInfrastructureFailure(stringFailure),
    stringFailure,
  );
  assert.throws(
    () => stringLedger.recordForAudit("refused"),
    /infrastructure previously failed: audit string failure/,
  );

  const objectLedger = createReviewerExecutionLedger();
  const snapshot = {
    repositoryRoot: "/repo",
    targetHead: "original-head",
    refs: { "refs/heads/main": "original-head" },
  };
  const disposition = { retained: "/original-workspace" };
  const sentinel = {
    label: "cleanup sentinel failure",
    targetSnapshot: snapshot,
    workspaceDisposition: disposition,
    toString() { return this.label; },
  };
  assert.equal(objectLedger.recordInfrastructureFailure(sentinel), sentinel);
  sentinel.label = "mutated diagnostic";
  snapshot.targetHead = "mutated-head";
  snapshot.refs["refs/heads/main"] = "mutated-head";
  disposition.retained = "/mutated-workspace";
  assert.throws(
    () => objectLedger.recordForAudit("refused"),
    /infrastructure previously failed: cleanup sentinel failure/,
  );
});

test("bash results pair by call ID in invocation order", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.recordBashCall("first", "git status --short");
  ledger.recordBashCall("second", "git diff --check");
  ledger.recordBashResult("second", "clean", false);
  ledger.recordBashResult("unknown", "ignored", true);
  ledger.recordBashResult("first", " M file", true);

  assert.deepEqual(ledger.recordForAudit("refused").bashEvidence, [
    { toolCallId: "first", command: "git status --short", result: " M file", isError: true },
    { toolCallId: "second", command: "git diff --check", result: "clean", isError: false },
  ]);
});

test("an empty refusal remains auditable without Skill or Agent evidence", () => {
  const record = createReviewerExecutionLedger().recordForAudit("refused");
  assert.deepEqual(record, {
    bashEvidence: [],
    agentAttempts: [],
    agentInvocationBatches: [],
  });
  assert.ok(Object.isFrozen(record));
});
