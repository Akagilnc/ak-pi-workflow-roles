import assert from "node:assert/strict";
import test from "node:test";

import { validateAcceptedJudgeDetails } from "../src/package-contracts/judge-output.ts";

test("converged rejection names exactly the submitted extra keys", () => {
  const cases = [
    {
      name: "classes alone",
      verdict: { judgeStatus: "converged", classes: [] },
      extraKeys: ["classes"],
    },
    {
      name: "fix alone",
      verdict: { judgeStatus: "converged", fix: { summary: "repair" } },
      extraKeys: ["fix"],
    },
    {
      name: "decisionGate alone",
      verdict: {
        judgeStatus: "converged",
        decisionGate: { question: "choose", options: ["A"] },
      },
      extraKeys: ["decisionGate"],
    },
    {
      name: "classes, fix, and decisionGate",
      verdict: {
        judgeStatus: "converged",
        classes: [],
        fix: { summary: "repair" },
        decisionGate: { question: "choose", options: ["A"] },
      },
      extraKeys: ["classes", "fix", "decisionGate"],
    },
    {
      name: "arbitrary unexpected key",
      verdict: { judgeStatus: "converged", unexpected: true },
      extraKeys: ["unexpected"],
    },
  ] as const;

  for (const testCase of cases) {
    assert.throws(
      () => validateAcceptedJudgeDetails(testCase.verdict),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const prefix = "Judge converged forbids extra keys: ";
        assert.equal(
          error.message,
          `${prefix}${testCase.extraKeys.join(", ")}`,
          testCase.name,
        );
        assert.deepEqual(
          error.message.slice(prefix.length).split(", "),
          testCase.extraKeys,
          testCase.name,
        );
        return true;
      },
    );
  }
});

test("converged exact keys remain accepted and returned unchanged", () => {
  const verdict = {
    judgeStatus: "converged",
    note: "archive the accepted evidence",
  } as const;

  assert.deepEqual(validateAcceptedJudgeDetails(verdict), verdict);
});
