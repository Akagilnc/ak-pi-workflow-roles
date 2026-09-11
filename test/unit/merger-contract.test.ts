import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../../src/sha256.ts";
import { validateMergerInput, validateMergerOutput } from "../../src/merger-contracts.ts";

const material = (text: string) => ({ bytesBase64: Buffer.from(text).toString("base64"), sha256: sha256Hex(text) });
const oid = (c: string) => c.repeat(40);
const valid = () => ({ attemptId: "attempt-22-a", targetObjectId: oid("a"), sourceObjectId: oid("b"), materials: { task: material("task\n"), authority: material("authority\n"), targetIntent: material("target\n"), sourceIntent: material("source\n") }, expectedConflictPaths: ["a.txt", "dir/b.txt"], resolutionScope: ["a.txt", "dir/b.txt"], authorizedChecks: [{ name: "unit", argv: ["npm", "test"] }] });

test("Merger input is deeply immutable and keeps attemptId for accounting", () => {
  const accepted = validateMergerInput(valid());
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.materials.task), true);
  assert.equal(accepted.attemptId, "attempt-22-a");
  assert.throws(() => validateMergerInput({ ...valid(), attemptId: "  " }), /attemptId/);
});

test("Merger input admits empty path materials and does not gate on OID/digest/scope", () => {
  const emptyPaths = validateMergerInput({ ...valid(), targetObjectId: "", sourceObjectId: "", expectedConflictPaths: [], resolutionScope: [] });
  assert.deepEqual([...emptyPaths.expectedConflictPaths], []);
  assert.equal(emptyPaths.targetObjectId, "");
  // Digest mismatch is not an attendance gate (#827).
  const drifted = valid(); drifted.materials.authority.sha256 = "0".repeat(64);
  assert.equal(validateMergerInput(drifted).attemptId, "attempt-22-a");
  // Scope need not contain conflicts — materials only.
  const looseScope = validateMergerInput({ ...valid(), resolutionScope: ["other.txt"] });
  assert.deepEqual([...looseScope.resolutionScope], ["other.txt"]);
});

test("Merger terminal leaves discriminate completed|escalate without attempt/OID gates", () => {
  const completed = validateMergerOutput({ status: "completed", attemptId: "any", report: "resolved", mergeCommitId: "not-an-oid" });
  assert.equal(completed.status, "completed");
  const escalated = validateMergerOutput({ status: "escalate", attemptId: "any", diagnosis: "no live merge", report: "nothing to do" });
  assert.equal(escalated.status, "escalate");
  assert.equal(validateMergerOutput({ status: "other", attemptId: "x", report: "x" }).status, "other");
});
