import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalJsonBytes } from "../src/canonical-json.ts";
import { statsLineEvidenceBytes } from "../src/doctor-contracts.ts";
import { evidenceAssertion } from "../src/doctor-evidence.ts";
import { sha256Hex } from "../src/sha256.ts";

test("Doctor consumers share recursive canonical JSON semantics", () => {
  const left = { zebra: [3, { beta: true, alpha: null }], alpha: "value" };
  const right = { alpha: "value", zebra: [3, { alpha: null, beta: true }] };
  const expected = '{"alpha":"value","zebra":[3,{"alpha":null,"beta":true}]}';
  assert.equal(canonicalJson(left), expected);
  assert.equal(canonicalJson(right), expected);
  assert.deepEqual(statsLineEvidenceBytes(left), canonicalJsonBytes(right));
  assert.deepEqual(evidenceAssertion(left), { sha256: sha256Hex(canonicalJsonBytes(right)), byteLength: canonicalJsonBytes(right).byteLength });
});
