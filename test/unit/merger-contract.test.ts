import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../../src/sha256.ts";
import { MergerInputContractError, validateMergerInput } from "../../src/merger-contracts.ts";

const material = (text: string) => ({ bytesBase64: Buffer.from(text).toString("base64"), sha256: sha256Hex(text) });
const oid = (c: string) => c.repeat(40);
const valid = () => ({ attemptId: "attempt-22-a", targetObjectId: oid("a"), sourceObjectId: oid("b"), materials: { task: material("task\n"), authority: material("authority\n"), targetIntent: material("target\n"), sourceIntent: material("source\n") }, expectedConflictPaths: ["a.txt", "dir/b.txt"], resolutionScope: ["a.txt", "dir/b.txt"], authorizedChecks: [{ name: "unit", argv: ["npm", "test"] }] });

test("Merger input rejects a blank attempt identity", () => {
  assert.doesNotThrow(() => validateMergerInput(valid()));
  assert.throws(() => validateMergerInput({ ...valid(), attemptId: "  " }), MergerInputContractError);
});
