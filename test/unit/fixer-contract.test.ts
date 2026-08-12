import assert from "node:assert/strict";
import test from "node:test";

import { Value } from "typebox/value";
import {
  fixerOutputSchema,
  validateFixerOutput,
  type FixerOutput,
} from "../../src/package-contracts/fixer-output.ts";
import { completed, refused, shaA } from "../helpers/fixer-fixtures.ts";

const legal: Array<{ phase: "plan" | "apply"; output: FixerOutput }> = [
  { phase: "plan", output: { status: "planned", report: "inspect and repair" } },
  { phase: "plan", output: { status: "refused", report: "cannot lawfully plan", remainingScope: "forbidden files", blocker: { cause: "authority_violation", evidence: "packet contradicts owner authority" } } },
  { phase: "apply", output: { status: "unfinished", report: "handover", remainingScope: "remaining parser cases", reason: "prerequisite_missing: parser fixture owner answer absent" } },
  { phase: "apply", output: { status: "unfinished", report: "handover with completed work", remainingScope: "remaining schema cases", reason: "unconstitutional: packet requires shape reject banned by ADR 0057", classResults: [completed()] } },
  { phase: "apply", output: { status: "completed", report: "settled", classResults: [completed()] } },
  // Differently named classes may share one commitSha (absorbed from judge-role production route).
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
