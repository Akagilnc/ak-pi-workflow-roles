import assert from "node:assert/strict";
import test from "node:test";

import { validateAcceptedJudgeDetails } from "../src/package-contracts/judge-output.ts";
import { validateAcceptedWorkerDetails } from "../src/package-contracts/worker-output.ts";

const judgeClass = {
  name: "ParserCase",
  owner: "parser owner",
  boundary: "parser boundary",
  disposition: "repair",
};

test("Judge class receipt enforces status, grammar, and exact-name uniqueness", () => {
  assert.deepEqual(validateAcceptedJudgeDetails({
    judgeStatus: "continue",
    fix: { summary: "repair" },
    classes: [judgeClass],
  }), {
    judgeStatus: "continue",
    fix: { summary: "repair" },
    classes: [judgeClass],
  });
  for (const invalid of [
    { judgeStatus: "continue", fix: { summary: "repair" } },
    { judgeStatus: "converged", classes: [judgeClass] },
    { judgeStatus: "continue", fix: { summary: "repair" }, classes: [{ ...judgeClass, name: "bad,key" }] },
    { judgeStatus: "continue", fix: { summary: "repair" }, classes: [judgeClass, { ...judgeClass }] },
  ]) assert.throws(() => validateAcceptedJudgeDetails(invalid), /class|forbids/);
});

test("classesRepaired is a Fixer completed-only receipt and Coder remains closed", () => {
  const classesRepaired = [{
    name: "ParserCase",
    searchScope: "all parser entry points",
    exceptions: [{ where: "legacy adapter", reason: "owned externally" }],
  }];
  assert.deepEqual(validateAcceptedWorkerDetails({
    status: "completed", report: "done", classesRepaired,
  }, "Fixer"), { status: "completed", report: "done", classesRepaired });
  for (const [output, role] of [
    [{ status: "planned", report: "plan", classesRepaired }, "Fixer"],
    [{ status: "refused", report: "no", classesRepaired }, "Fixer"],
    [{ status: "completed", report: "done", classesRepaired }, "Coder"],
    [{ status: "completed", report: "done", classesRepaired: [{ ...classesRepaired[0], name: "bad,key" }] }, "Fixer"],
    [{ status: "completed", report: "done", classesRepaired: [...classesRepaired, ...classesRepaired] }, "Fixer"],
  ] as const) assert.throws(() => validateAcceptedWorkerDetails(output, role), /classesRepaired/);
});
