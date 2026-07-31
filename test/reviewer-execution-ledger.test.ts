import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createReviewerExecutionLedger,
  type ReviewerEvidenceEvent,
  type ReviewerUsage,
} from "../src/reviewer-execution-ledger.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const target = { repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "abc", refs: { "refs/heads/main": { objectId: "abc", peeledCommitId: "abc" } } };
const range = { base: "base", target: "abc", diffCommand: "git diff base...abc", diffSha256: sha("diff"), commits: ["abc"] };
const grant = { tools: ["read"] as const, bashCommands: [] as const, prerequisiteOperations: ["preflight.git.pin-target"] as const };
const usage: ReviewerUsage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };

function accepted(spec = true): ReviewerEvidenceEvent {
  const prompts = spec ? [["standards", "standards π"], ["spec", "spec prompt"]] as const : [["standards", "standards π"]] as const;
  return {
    source: "reviewer-dispatch", type: "accepted", identity: "proposal-1", recipe: "reviewer-dispatch-v1",
    input: { task: { text: "task", utf8Length: 4, sha256: sha("task") }, canonicalSkillSha256: "skill-sha", capabilityDocument: { text: "{\"ceiling\":1}", utf8Length: 13, sha256: sha("{\"ceiling\":1}") } }, target, prerequisiteOperations: [], range,
    materials: { standards: [{ id: "rules", repositoryPath: "RULES.md", text: "rules", utf8Length: 5, sha256: sha("rules") }], ...(spec ? { spec: [{ id: "requirements", repositoryPath: "SPEC.md", text: "spec", utf8Length: 4, sha256: sha("spec") }] } : { noSpecEvidence: [{ id: "absence", repositoryPath: "README.md", text: "absence", utf8Length: 7, sha256: sha("absence") }] }) },
    legs: prompts.map(([axis, prompt]) => ({ axis, prompt: { text: prompt, utf8Length: Buffer.byteLength(prompt), sha256: sha(prompt) }, grant })),
  } as ReviewerEvidenceEvent;
}

function settled(axis: "standards" | "spec", prompt: string): ReviewerEvidenceEvent {
  return { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: "proposal-1", axis, status: "successful", prompt: { text: prompt, utf8Length: Buffer.byteLength(prompt), sha256: sha(prompt) }, target, report: `${axis} report`, usage, workspaceDisposition: "deleted" } as const;
}

test("transport rejection is immutable, bounded, ordered, and retains no raw arguments", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.append({ source: "reviewer-transport", type: "transport-rejected", identity: "transport-abc", violation: "schema", started: false });
  const record = ledger.recordForAudit("refused");
  assert.deepEqual(record.transportRejections, [{ identity: "transport-abc", violation: "schema", started: false }]);
  assert.equal(JSON.stringify(record).includes("secret"), false);
  assert.throws(() => ledger.append({ source: "reviewer-transport", type: "transport-rejected", identity: "x", violation: "schema", started: false, args: "secret" } as any), /only immutable/);
});

test("established Spec completion projects one accepted sibling dispatch and exact actual evidence", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.append(accepted());
  ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: "proposal-1", cardinality: 2 });
  ledger.append(settled("standards", "standards π"));
  ledger.append(settled("spec", "spec prompt"));

  const record = ledger.recordForAudit("completed");
  assert.equal(record.accepted?.legs[0]?.prompt.utf8Length, 12);
  assert.deepEqual(record.started, { dispatchIdentity: "proposal-1", cardinality: 2 });
  assert.deepEqual(Object.keys(record.results), ["standards", "spec"]);
  assert.equal(record.results.spec?.prompt.text, "spec prompt");
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.accepted?.target.refs));
  assert.throws(() => { (record.results.standards!.usage!.cost as any).total = 99; }, TypeError);
});

test("audit evidence retains capability document identity and rejects mutation fatally", () => {
  const ledger = createReviewerExecutionLedger();
  const event = accepted() as any;
  ledger.append(event);
  assert.deepEqual(ledger.recordForAudit("refused").accepted?.input.capabilityDocument, event.input.capabilityDocument);

  for (const mutation of [
    { text: "{\"ceiling\":2}" },
    { utf8Length: event.input.capabilityDocument.utf8Length + 1 },
    { sha256: "0".repeat(64) },
  ]) {
    const rejectingLedger = createReviewerExecutionLedger();
    const changed = accepted() as any;
    changed.input.capabilityDocument = { ...changed.input.capabilityDocument, ...mutation };
    assert.throws(() => rejectingLedger.append(changed), /capability document bytes, length, or SHA disagree/);
  }
});

test("both sibling failures preserve exact settlement order and bounded evidence", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.append(accepted(true));
  ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: "proposal-1", cardinality: 2 });
  for (const [axis, prompt, failure] of [["standards", "standards π", "provider"], ["spec", "spec prompt", "child"]] as const) {
    ledger.append({ source: "reviewer-agent", type: "leg-settled", dispatchIdentity: "proposal-1", axis, status: "failed", prompt: { text: prompt, utf8Length: Buffer.byteLength(prompt), sha256: sha(prompt) }, target, failure, workspaceDisposition: "not-created" });
  }
  const record = ledger.recordForAudit("refused");
  assert.deepEqual(Object.keys(record.results), ["standards", "spec"]);
  assert.deepEqual([record.results.standards?.failure, record.results.spec?.failure], ["provider", "child"]);
});

test("no-Spec completion proves one Standards-only dispatch and no Spec evidence", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.append(accepted(false));
  ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: "proposal-1", cardinality: 1 });
  ledger.append(settled("standards", "standards π"));
  const record = ledger.recordForAudit("completed");
  assert.equal(record.accepted?.legs.length, 1);
  assert.equal(record.results.spec, undefined);
});

test("rejections remain no-start facts and cannot smuggle runner evidence", () => {
  const ledger = createReviewerExecutionLedger();
  const violations: any = ["capability-invalid"];
  ledger.append({ source: "reviewer-dispatch", type: "rejected", identity: "bad", violations, started: false });
  violations[0] = "mutated";
  const record = ledger.recordForAudit("refused");
  assert.deepEqual(record.rejections, [{ identity: "bad", violations: ["capability-invalid"], started: false }]);
  assert.equal(record.started, undefined);
  assert.deepEqual(record.results, {});
  assert.throws(() => ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: "bad", cardinality: 1 }), /accepted dispatch/);
});

test("closed attempts project durably after acceptance without reopening lifecycle", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.append(accepted(false));
  ledger.append({ source: "reviewer-dispatch", type: "closed-attempt", identity: "late", reason: "acceptance-closed", started: false });
  const record = ledger.recordForAudit("refused");
  assert.deepEqual(record.closedAttempts, [{ identity: "late", reason: "acceptance-closed", started: false }]);
  assert.throws(() => (record.closedAttempts as any[]).push({}));
});

test("projection is append-only and rejects duplicate, mismatched, or incomplete lifecycle evidence", () => {
  const ledger = createReviewerExecutionLedger();
  ledger.append(accepted());
  assert.throws(() => ledger.append(accepted()), /exactly one accepted/);
  ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: "proposal-1", cardinality: 2 });
  assert.throws(() => ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: "proposal-1", cardinality: 2 }), /exactly once/);
  assert.throws(() => ledger.append(settled("standards", "wrong bytes")), /compiled prompt/);
  assert.throws(() => ledger.recordForAudit("completed"), /both axes.*successfully|settled successfully/);
});

test("fatal infrastructure evidence is preserved for the auditor", () => {
  const ledger = createReviewerExecutionLedger();
  const error = Object.assign(new Error("provider unavailable"), { targetSnapshot: target, workspaceDisposition: { retained: "/tmp/ws" } });
  assert.equal(ledger.recordInfrastructureFailure(error), error);
  assert.throws(() => ledger.recordForAudit("completed"), /infrastructure previously failed: infrastructure-failure/);
  assert.throws(() => ledger.recordForAudit("refused"), /infrastructure previously failed: infrastructure-failure/);
});
