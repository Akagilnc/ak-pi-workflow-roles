/**
 * #356 T1 / #376 — engine material is optional notes, not a closed name catalog.
 * Entry-reachable delivery is covered by public-cli-engine-axis tracer.
 * This file keeps pure helper seams: path-safety syntax + session-line attach.
 * FS discovery (listEngineMaterialNames / engineSessionMaterialFromOptions) lives
 * under test/integration/engine-material.test.ts (#631 unit-tier honesty).
 * Tests never treat material body CLI text as a contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLegalEngineName,
} from "../../src/package-resources/engine-material.ts";

test("assertLegalEngineName rejects only real path hazards; consecutive dots pass", () => {
  // Real hazards: traversal parents, separators, NUL, exact "." / "..".
  // Well-formed names (incl. company..opus) are never rejected for missing notes (#376).
  for (const name of ["../escape", "has/slash", "has\\slash", "has\0nul", ".", "..", ""]) {
    assert.throws(() => assertLegalEngineName(name), (err: unknown) =>
      err instanceof Error && Object.getPrototypeOf(err) === Error.prototype);
  }
  assert.equal(assertLegalEngineName("nope-engine"), "nope-engine");
  assert.equal(assertLegalEngineName("opus"), "opus");
  assert.equal(assertLegalEngineName("company..opus"), "company..opus");
});
