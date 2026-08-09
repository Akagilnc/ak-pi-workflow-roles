import assert from "node:assert/strict";
import test from "node:test";

import {
  projectJudgeVerdictForAudit,
  type JudgeVerdict,
} from "../../src/judge-role.ts";
import { validateAcceptedJudgeDetails } from "../../src/package-contracts/judge-output.ts";


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
