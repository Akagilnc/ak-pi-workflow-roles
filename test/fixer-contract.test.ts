import assert from "node:assert/strict";
import test from "node:test";

import { Value } from "typebox/value";
import {
  fixerOutputSchema,
  validateFixerOutput,
  type FixerOutput,
} from "../src/package-contracts/fixer-output.ts";

const shaA = "a".repeat(40);
const shaB = "b".repeat(64);
const completed = (name = "ParserCase", commitSha = shaA) => ({
  name,
  disposition: "completed" as const,
  searchScope: "all parser entry points",
  exceptions: [{ where: "legacy adapter", reason: "already correct" }],
  commitSha,
});
const refused = (name = "TransportCase") => ({
  name,
  disposition: "refused" as const,
  remainingScope: "provider-backed execution",
  blocker: { cause: "prerequisite_unmet" as const, evidence: "required repository is absent" },
});

const legal: Array<{ phase: "plan" | "apply"; output: FixerOutput }> = [
  { phase: "plan", output: { status: "planned", report: "inspect and repair" } },
  { phase: "plan", output: { status: "refused", report: "cannot lawfully plan", remainingScope: "forbidden files", blocker: { cause: "authority_violation", evidence: "packet contradicts owner authority" } } },
  { phase: "apply", output: { status: "completed", report: "settled", classResults: [completed()] } },
  { phase: "apply", output: { status: "completed", report: "settled both", classResults: [completed(), completed("SchemaCase", shaB)] } },
  { phase: "apply", output: { status: "refused", report: "blocked", classResults: [refused()] } },
  { phase: "apply", output: { status: "partially_completed", report: "lawful mixed settlement", classResults: [completed(), refused()] } },
];

test("every legal Fixer plan/apply shape crosses the public TypeBox schema and production validator", () => {
  for (const row of legal) {
    assert.equal(Value.Check(fixerOutputSchema, row.output), true, JSON.stringify(row.output));
    assert.deepEqual(validateFixerOutput(row.output, row.phase), row.output);
  }
});

test("Fixer hard-cuts legacy leaves and enforces exact plan/apply unions", () => {
  const invalid = [
    ["apply", { status: "completed", report: "old", commitSha: shaA }],
    ["apply", { status: "completed", report: "old", classesRepaired: [] }],
    ["plan", { status: "planned", report: "x", classResults: [completed()] }],
    ["plan", { status: "partially_completed", report: "x" }],
    ["apply", { status: "planned", report: "x" }],
    ["plan", { status: "refused", report: "x", remainingScope: " ", blocker: { cause: "prerequisite_unmet", evidence: "x" } }],
    ["plan", { status: "refused", report: "x", remainingScope: "x", blocker: { cause: "safety", evidence: "x" } }],
    ["apply", { status: "completed", report: "x", classResults: [completed("A"), completed("A", shaB)] }],
    ["apply", { status: "completed", report: "x", classResults: [completed("A"), completed("B", shaA)] }],
    ["apply", { status: "completed", report: "x", classResults: [completed("A", "abc")] }],
    ["apply", { status: "partially_completed", report: "unfinished", classResults: [completed()] }],
    ["apply", { status: "partially_completed", report: "unfinished", classResults: [refused()] }],
    ["apply", { status: "completed", report: "mixed", classResults: [completed(), refused()] }],
    ["apply", { status: "refused", report: "mixed", classResults: [completed(), refused()] }],
  ] as const;
  for (const [phase, output] of invalid) {
    assert.throws(() => validateFixerOutput(output, phase), /Fixer/);
  }
});
