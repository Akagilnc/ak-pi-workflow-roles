import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../../src/sha256.ts";
import { validateMergerInput, validateMergerOutput } from "../../src/merger-contracts.ts";

const material = (text: string) => ({ bytesBase64: Buffer.from(text).toString("base64"), sha256: sha256Hex(text) });
const oid = (c: string) => c.repeat(40);
const valid = () => ({
  version: 1 as const,
  attemptId: "attempt-22-a",
  targetObjectId: oid("a"),
  sourceObjectId: oid("b"),
  materials: { task: material("task\n"), authority: material("authority\n"), targetIntent: material("target\n"), sourceIntent: material("source\n") },
  expectedConflictPaths: ["a.txt", "dir/b.txt"],
  resolutionScope: ["a.txt", "dir/b.txt"],
  authorizedChecks: [{ name: "unit", argv: ["npm", "test"] }],
});

test("Merger input is deeply immutable and binds exact admitted bytes", () => {
  const accepted = validateMergerInput(valid());
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.materials.task), true);
  assert.equal(Object.isFrozen(accepted.authorizedChecks[0]!.argv), true);
  const drifted = valid(); drifted.materials.authority.sha256 = "0".repeat(64);
  assert.throws(() => validateMergerInput(drifted), /digest/);
  const taskDrift = valid(); taskDrift.materials.task.sha256 = "0".repeat(64);
  assert.throws(() => validateMergerInput(taskDrift), /digest/);
});

test("Merger input rejects identity, path-set, scope, and check ambiguity", () => {
  assert.throws(() => validateMergerInput({ ...valid(), targetObjectId: "ABC" }), /object ID/);
  assert.throws(() => validateMergerInput({ ...valid(), resolutionScope: ["a.txt"] }), /scope/);
  assert.throws(() => validateMergerInput({ ...valid(), authorizedChecks: [{ name: "unit", argv: [] }] }), /check/);
});

test("Merger terminal leaves are exact and attempt-bound", () => {
  const expectedAttemptId = "attempt-22-a";
  const completed = validateMergerOutput({ status: "completed", attemptId: expectedAttemptId, report: "resolved", mergeCommitId: oid("c") }, expectedAttemptId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.attemptId, expectedAttemptId);
  assert.equal(completed.mergeCommitId, oid("c"));
  const escalated = validateMergerOutput({ status: "escalate", attemptId: expectedAttemptId, diagnosis: "intents conflict", report: "owner decision required" }, expectedAttemptId);
  assert.equal(escalated.status, "escalate");
  assert.equal(escalated.attemptId, expectedAttemptId);
  assert.throws(
    () => validateMergerOutput({ status: "completed", attemptId: "wrong", report: "x", mergeCommitId: oid("c") }, expectedAttemptId),
    Error,
  );
});
