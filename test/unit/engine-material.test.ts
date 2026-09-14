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
  appendEngineSessionMaterial,
  assertLegalEngineName,
} from "../../src/package-resources/engine-material.ts";

test("assertLegalEngineName rejects only real path hazards; consecutive dots pass", () => {
  // Real hazards: traversal parents, separators, NUL, exact "." / "..".
  // Well-formed names (incl. company..opus) are never rejected for missing notes (#376).
  assert.throws(
    () => assertLegalEngineName("../escape"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName("has/slash"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName("has\\slash"),
    /illegal engine name/,
  );
  assert.throws(
    () => assertLegalEngineName("has\0nul"),
    /illegal engine name/,
  );
  assert.throws(() => assertLegalEngineName("."), /illegal engine name/);
  assert.throws(() => assertLegalEngineName(".."), /illegal engine name/);
  assert.throws(
    () => assertLegalEngineName(""),
    /illegal engine name/,
  );
  assert.equal(assertLegalEngineName("nope-engine"), "nope-engine");
  assert.equal(assertLegalEngineName("opus"), "opus");
  assert.equal(assertLegalEngineName("company..opus"), "company..opus");
});

test("appendEngineSessionMaterial: engine name line; notes also carry path", () => {
  // Structured coordinates only — no presentation-header pin (#495 S4 / ADR 0073).
  const nameOnly = appendEngineSessionMaterial(["base"], { name: "company..opus" });
  assert.equal(nameOnly.includes("- engine: company..opus"), true);
  assert.equal(
    nameOnly.some((line) => line.startsWith("- /") || line.includes("/resources/engines/")),
    false,
    "name-only path must not carry a material path",
  );

  const withNotes = appendEngineSessionMaterial(["base"], {
    name: "cursor",
    materialPath: "/abs/resources/engines/cursor.md",
  });
  assert.equal(withNotes.includes("- engine: cursor"), true);
  assert.equal(withNotes.includes("- /abs/resources/engines/cursor.md"), true);
});
