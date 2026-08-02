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
    {
      name: "foreign key beside retained evidence",
      verdict: {
        judgeStatus: "converged",
        evidence: { checks: [{ name: "settled-audit", passed: true }] },
        unexpected: true,
      },
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
  const evidence = {
    checks: [{ name: "settled-audit", passed: true }],
    empty: {},
  } as const;
  const verdict = {
    judgeStatus: "converged",
    note: "archive the accepted evidence",
    evidence,
  } as const;

  const accepted = validateAcceptedJudgeDetails(verdict);
  assert.deepEqual(accepted, verdict);
  assert.equal(accepted.evidence, evidence);
});

test("retained evidence is optional, opaque, and lawful on every judge status", () => {
  const verdicts = [
    { judgeStatus: "converged", evidence: {} },
    {
      judgeStatus: "continue",
      fix: { summary: "repair" },
      classes: [{ name: "Contract", owner: "runtime", boundary: "judge output", disposition: "repair" }],
      evidence: [],
    },
    {
      judgeStatus: "escalate",
      decisionGate: { question: "Choose", options: ["A"] },
      evidence: null,
    },
  ] as const;

  for (const verdict of verdicts) {
    assert.deepEqual(validateAcceptedJudgeDetails(verdict), verdict);
  }
});
