import assert from "node:assert/strict";
import test from "node:test";

import { Value } from "typebox/value";
import {
  fixerOutputSchema,
  validateFixerOutput,
  type FixerOutput,
} from "../../src/package-contracts/fixer-output.ts";

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
  blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "repository.ready", evidence: "required repository is absent" },
});

const legal: Array<{ phase: "plan" | "apply"; output: FixerOutput }> = [
  { phase: "plan", output: { status: "planned", report: "inspect and repair" } },
  { phase: "plan", output: { status: "refused", report: "cannot lawfully plan", remainingScope: "forbidden files", blocker: { cause: "authority_violation", evidence: "packet contradicts owner authority" } } },
  { phase: "apply", output: { status: "unfinished", report: "handover", remainingScope: "remaining parser cases" } },
  { phase: "apply", output: { status: "unfinished", report: "handover with completed work", remainingScope: "remaining schema cases", classResults: [completed()] } },
  { phase: "apply", output: { status: "completed", report: "settled", classResults: [completed()] } },
  { phase: "apply", output: { status: "completed", report: "settled both", classResults: [completed(), completed("SchemaCase", shaA)] } },
  { phase: "apply", output: { status: "refused", report: "blocked", classResults: [refused()] } },
  { phase: "apply", output: { status: "partially_completed", report: "lawful mixed settlement", classResults: [completed(), refused()] } },
];

test("every legal Fixer plan/apply shape crosses the public TypeBox schema and production validator", () => {
  for (const row of legal) {
    assert.equal(Value.Check(fixerOutputSchema, row.output), true, JSON.stringify(row.output));
    assert.deepEqual(validateFixerOutput(row.output, row.phase), row.output);
  }
});

test("Fixer projects semantic settlements despite presentation trivia", () => {
  const candidate = {
    presentation: "ignored",
    classResults: [
      { ...completed("Parser, Unicode，Case", "REVISION-A"), decoration: true, exceptions: [{ where: "legacy adapter", reason: "already correct", note: "presentation" }] },
      { ...completed("SchemaCase", "revision-B"), decoration: true },
    ],
    report: "settled",
    status: "completed" as const,
  };
  assert.equal(Value.Check(fixerOutputSchema, candidate), true);
  assert.deepEqual(validateFixerOutput(candidate, "apply"), {
    status: "completed",
    report: "settled",
    classResults: [completed("Parser, Unicode，Case", "REVISION-A"), completed("SchemaCase", "revision-B")],
  });
});

test("Fixer hard-cuts legacy leaves and enforces semantic plan/apply unions", () => {
  // Per-row diagnostics name the violated field/constraint (absorbed from the
  // former standalone "every surviving Fixer rejection names..." carrier).
  const invalid: Array<readonly ["plan" | "apply", unknown, RegExp]> = [
    ["apply", { status: "completed", report: "old", commitSha: shaA }, /Fixer/],
    ["apply", { status: "completed", report: "old", classesRepaired: [] }, /Fixer/],
    ["plan", { status: "planned", report: "x", classResults: [completed()] }, /Fixer/],
    ["plan", { status: "partially_completed", report: "x" }, /Fixer/],
    ["plan", { status: "unfinished", report: "x", remainingScope: "later" }, /Fixer/],
    ["apply", { status: "planned", report: "x" }, /Fixer/],
    ["apply", { status: "unfinished", report: "x", remainingScope: " " }, /Fixer/],
    ["apply", { status: "unfinished", report: "x", remainingScope: "later", classResults: [] }, /Fixer/],
    ["apply", { status: "unfinished", report: "x", remainingScope: "later", classResults: [refused()] }, /Fixer/],
    ["plan", { status: "refused", report: "x", remainingScope: " ", blocker: { cause: "prerequisite_unmet", prerequisiteId: "repository.ready", evidence: "x" } }, /Fixer/],
    ["plan", { status: "refused", report: "x", remainingScope: "x", blocker: { cause: "prerequisite_unmet", evidence: "x" } }, /Fixer/],
    ["plan", { status: "refused", report: "x", remainingScope: "x", blocker: { cause: "safety", evidence: "x" } }, /Fixer/],
    ["apply", { status: "completed", report: "x", classResults: [completed("A"), completed("A", shaB)] }, /classResults.*name.*unique/i],
    ["apply", { status: "completed", report: "x", classResults: [completed("A", " ")] }, /classResults\[0\]\.commitSha nonblank/i],
    ["apply", { status: "completed", report: "x", classResults: [{ name: "A", disposition: "completed", searchScope: "all parser entry points", exceptions: [] }] }, /classResults\[0\]\.commitSha nonblank/i],
    ["apply", { status: "partially_completed", report: "unfinished", classResults: [completed()] }, /Fixer/],
    ["apply", { status: "partially_completed", report: "unfinished", classResults: [refused()] }, /Fixer/],
    ["apply", { status: "completed", report: "mixed", classResults: [completed(), refused()] }, /Fixer/],
    ["apply", { status: "refused", report: "mixed", classResults: [completed(), refused()] }, /Fixer/],
    ["apply", { status: "completed", report: " ", classResults: [completed()] }, /report.*nonblank/i],
    ["apply", { status: "completed", report: "x", classResults: [{ name: "A" }] }, /classResults.*disposition/i],
  ];
  for (const [phase, output, diagnostic] of invalid) {
    assert.throws(() => validateFixerOutput(output, phase), diagnostic);
  }
});

// Absorbed: field-naming negatives now live as diagnostic rows in the hard-cuts table above.

test("Fixer rejects branch-incompatible semantic fields while ignoring presentation decoration", () => {
  const contradictions = [
    { candidate: { ...legal[1]!.output, classResults: [refused()] }, phase: "plan", diagnostic: /plan\/apply semantic-field combination/ },
    { candidate: { status: "unfinished", report: "x", remainingScope: "later", blocker: { cause: "authority_violation", evidence: "x" } }, phase: "apply", diagnostic: /unfinished semantic-field combination/ },
    { candidate: { status: "completed", report: "x", commitSha: shaA, classResults: [completed()] }, phase: "apply", diagnostic: /removed top-level commit semantic-field/ },
    { candidate: { ...legal[1]!.output, blocker: { cause: "authority_violation", evidence: "x", prerequisiteId: "repository.ready" } }, phase: "plan", diagnostic: /authority_violation prerequisiteId semantic-field/ },
    { candidate: { status: "completed", report: "x", classResults: [{ ...completed(), remainingScope: "contradiction" }] }, phase: "apply", diagnostic: /completed\/refused semantic-field combination/ },
    { candidate: { status: "refused", report: "x", classResults: [{ ...refused(), commitSha: shaA }] }, phase: "apply", diagnostic: /refused\/completed semantic-field combination/ },
  ] as const;
  for (const row of contradictions) assert.throws(() => validateFixerOutput(row.candidate, row.phase), row.diagnostic);
  assert.deepEqual(validateFixerOutput({ ...legal[1]!.output, presentation: { commitSha: shaA }, blocker: { ...(legal[1]!.output as any).blocker, note: "display only" } }, "plan"), legal[1]!.output);
});


