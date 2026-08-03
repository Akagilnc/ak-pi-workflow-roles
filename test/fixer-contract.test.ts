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
  blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "repository.ready", evidence: "required repository is absent" },
});

const legal: Array<{ phase: "plan" | "apply"; output: FixerOutput }> = [
  { phase: "plan", output: { status: "planned", report: "inspect and repair" } },
  { phase: "plan", output: { status: "refused", report: "cannot lawfully plan", remainingScope: "forbidden files", blocker: { cause: "authority_violation", evidence: "packet contradicts owner authority" } } },
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
  const invalid = [
    ["apply", { status: "completed", report: "old", commitSha: shaA }],
    ["apply", { status: "completed", report: "old", classesRepaired: [] }],
    ["plan", { status: "planned", report: "x", classResults: [completed()] }],
    ["plan", { status: "partially_completed", report: "x" }],
    ["apply", { status: "planned", report: "x" }],
    ["plan", { status: "refused", report: "x", remainingScope: " ", blocker: { cause: "prerequisite_unmet", prerequisiteId: "repository.ready", evidence: "x" } }],
    ["plan", { status: "refused", report: "x", remainingScope: "x", blocker: { cause: "prerequisite_unmet", evidence: "x" } }],
    ["plan", { status: "refused", report: "x", remainingScope: "x", blocker: { cause: "safety", evidence: "x" } }],
    ["apply", { status: "completed", report: "x", classResults: [completed("A"), completed("A", shaB)] }],
    ["apply", { status: "completed", report: "x", classResults: [completed("A", " ")] }],
    ["apply", { status: "completed", report: "x", classResults: [{ name: "A", disposition: "completed", searchScope: "all parser entry points", exceptions: [] }] }],
    ["apply", { status: "partially_completed", report: "unfinished", classResults: [completed()] }],
    ["apply", { status: "partially_completed", report: "unfinished", classResults: [refused()] }],
    ["apply", { status: "completed", report: "mixed", classResults: [completed(), refused()] }],
    ["apply", { status: "refused", report: "mixed", classResults: [completed(), refused()] }],
  ] as const;
  for (const [phase, output] of invalid) {
    assert.throws(() => validateFixerOutput(output, phase), /Fixer/);
  }
});

test("Fixer rejects branch-incompatible semantic fields while ignoring presentation decoration", () => {
  const contradictions = [
    { candidate: { ...legal[1]!.output, classResults: [refused()] }, phase: "plan", diagnostic: /plan\/apply semantic-field combination/ },
    { candidate: { status: "completed", report: "x", commitSha: shaA, classResults: [completed()] }, phase: "apply", diagnostic: /removed top-level commit semantic-field/ },
    { candidate: { ...legal[1]!.output, blocker: { cause: "authority_violation", evidence: "x", prerequisiteId: "repository.ready" } }, phase: "plan", diagnostic: /authority_violation prerequisiteId semantic-field/ },
    { candidate: { status: "completed", report: "x", classResults: [{ ...completed(), remainingScope: "contradiction" }] }, phase: "apply", diagnostic: /completed\/refused semantic-field combination/ },
    { candidate: { status: "refused", report: "x", classResults: [{ ...refused(), commitSha: shaA }] }, phase: "apply", diagnostic: /refused\/completed semantic-field combination/ },
  ] as const;
  for (const row of contradictions) assert.throws(() => validateFixerOutput(row.candidate, row.phase), row.diagnostic);
  assert.deepEqual(validateFixerOutput({ ...legal[1]!.output, presentation: { commitSha: shaA }, blocker: { ...(legal[1]!.output as any).blocker, note: "display only" } }, "plan"), legal[1]!.output);
});

test("every surviving Fixer rejection names its violated field or constraint", () => {
  assert.throws(() => validateFixerOutput({ status: "completed", report: " ", classResults: [completed()] }, "apply"), /report.*nonblank/i);
  assert.throws(() => validateFixerOutput({ status: "completed", report: "x", classResults: [completed("A"), completed("A", shaB)] }, "apply"), /classResults.*name.*unique/i);
  assert.throws(() => validateFixerOutput({ status: "completed", report: "x", classResults: [completed("A", " ")] }, "apply"), /classResults\[0\]\.commitSha nonblank/i);
  assert.throws(() => validateFixerOutput({ status: "completed", report: "x", classResults: [{ name: "A", disposition: "completed", searchScope: "all parser entry points", exceptions: [] }] }, "apply"), /classResults\[0\]\.commitSha nonblank/i);
  assert.throws(() => validateFixerOutput({ status: "completed", report: "x", classResults: [{ name: "A" }] }, "apply"), /classResults.*disposition/i);
});
