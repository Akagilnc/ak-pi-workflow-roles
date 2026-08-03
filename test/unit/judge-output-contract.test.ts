import assert from "node:assert/strict";
import test from "node:test";

import {
  projectJudgeVerdictForAudit,
  type JudgeVerdict,
} from "../../src/judge-role.ts";
import { validateAcceptedJudgeDetails } from "../../src/package-contracts/judge-output.ts";

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

test("retained evidence and optional note are lawful on every judge status", () => {
  const verdicts = [
    { judgeStatus: "converged", note: "Archive the accepted evidence.", evidence: {} },
    {
      judgeStatus: "continue",
      fix: { summary: "repair" },
      classes: [{ name: "Contract", owner: "runtime", boundary: "judge output", disposition: "repair" }],
      note: "Keep the fresh test output with the repair record.",
      evidence: [],
    },
    {
      judgeStatus: "escalate",
      decisionGate: { question: "Choose", options: ["A"] },
      note: "Include the trade-off note for whoever decides.",
      evidence: null,
    },
  ] as const;

  for (const verdict of verdicts) {
    const accepted = validateAcceptedJudgeDetails(verdict);
    assert.deepEqual(accepted, verdict);
    assert.equal(accepted.note, verdict.note);
  }
});

test("mixed and blank verdict shapes reject with named status diagnostics", () => {
  const gate = { question: "Choose", options: ["A"] };
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["converged with fix", { judgeStatus: "converged", fix: { summary: "x" } }, /Judge converged/],
    ["converged with gate", { judgeStatus: "converged", decisionGate: gate }, /Judge converged/],
    ["converged with unknown field", { judgeStatus: "converged", memo: "extra" }, /Judge converged/],
    ["converged with blank note", { judgeStatus: "converged", note: " \n" }, /Judge note/],
    ["continue without fix", { judgeStatus: "continue" }, /Judge continue/],
    ["continue without classes", { judgeStatus: "continue", fix: { summary: "repair" } }, /Judge continue/],
    ["continue with blank summary", { judgeStatus: "continue", fix: { summary: " \n" } }, /Judge continue/],
    ["continue with extra fix field", { judgeStatus: "continue", fix: { summary: "x", note: "extra" } }, /Judge continue/],
    ["continue with gate", { judgeStatus: "continue", fix: { summary: "x" }, decisionGate: gate }, /Judge continue/],
    ["continue name grammar", {
      judgeStatus: "continue",
      fix: { summary: "repair" },
      classes: [{ name: "bad,key", owner: "o", boundary: "b", disposition: "d" }],
    }, /class|name/i],
    ["continue duplicate class names", {
      judgeStatus: "continue",
      fix: { summary: "repair" },
      classes: [
        { name: "ParserCase", owner: "o", boundary: "b", disposition: "d" },
        { name: "ParserCase", owner: "o", boundary: "b", disposition: "d" },
      ],
    }, /class|unique|name/i],
    ["escalate without gate", { judgeStatus: "escalate" }, /Judge escalate/],
    ["escalate with blank question", { judgeStatus: "escalate", decisionGate: { question: "  ", options: ["A"] } }, /Judge escalate/],
    ["escalate with no options", { judgeStatus: "escalate", decisionGate: { question: "Choose", options: [] } }, /Judge escalate/],
    ["escalate with blank option", { judgeStatus: "escalate", decisionGate: { question: "Choose", options: ["A", " "] } }, /Judge escalate/],
    ["escalate with fix", { judgeStatus: "escalate", decisionGate: gate, fix: { summary: "x" } }, /Judge escalate/],
  ];

  for (const [name, verdict, diagnostic] of cases) {
    assert.throws(() => validateAcceptedJudgeDetails(verdict), diagnostic, name);
  }
});

test("projectJudgeVerdictForAudit strips evidence on every status while retaining adjudicative fields and note", () => {
  const verdicts: JudgeVerdict[] = [
    { judgeStatus: "converged", note: "keep", evidence: { checks: ["converged"] } },
    {
      judgeStatus: "continue",
      fix: { summary: "Repair the parser" },
      classes: [{
        name: "parser-contract",
        owner: "parser",
        boundary: "input parsing",
        disposition: "repair malformed input handling",
      }],
      note: "advisories stay",
      evidence: [],
    },
    {
      judgeStatus: "escalate",
      decisionGate: { question: "Which API?", options: ["A", "B"] },
      evidence: null,
    },
  ];

  assert.deepEqual(verdicts.map(projectJudgeVerdictForAudit), [
    { judgeStatus: "converged", note: "keep" },
    {
      judgeStatus: "continue",
      fix: { summary: "Repair the parser" },
      classes: [{
        name: "parser-contract",
        owner: "parser",
        boundary: "input parsing",
        disposition: "repair malformed input handling",
      }],
      note: "advisories stay",
    },
    {
      judgeStatus: "escalate",
      decisionGate: { question: "Which API?", options: ["A", "B"] },
    },
  ]);
});
