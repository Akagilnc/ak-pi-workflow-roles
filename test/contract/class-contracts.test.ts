import assert from "node:assert/strict";
import test from "node:test";

import { validateAcceptedJudgeDetails } from "../../src/package-contracts/judge-output.ts";
import { validateAcceptedWorkerDetails } from "../../src/package-contracts/worker-output.ts";

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

test("current Fixer settlement is independent while Coder remains byte-compatible and closed", () => {
  const fixer = { status: "completed", report: "done", classResults: [{
    name: "ParserCase", disposition: "completed", searchScope: "all parser entry points",
    exceptions: [{ where: "legacy adapter", reason: "already correct" }], commitSha: "a".repeat(40),
  }] };
  assert.deepEqual(validateAcceptedWorkerDetails(fixer, "Fixer"), fixer);
  assert.deepEqual(validateAcceptedWorkerDetails({ status: "completed", report: "done", commitSha: "advisory" }, "Coder"), { status: "completed", report: "done", commitSha: "advisory" });
  assert.throws(() => validateAcceptedWorkerDetails(fixer, "Coder"), /Coder output/);
  assert.throws(() => validateAcceptedWorkerDetails({ status: "completed", report: "old", classesRepaired: [] }, "Fixer"), /Fixer output/);
});
