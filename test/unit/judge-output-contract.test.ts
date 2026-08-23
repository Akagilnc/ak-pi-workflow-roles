import assert from "node:assert/strict";
import test from "node:test";

import { validateAcceptedJudgeDetails } from "../../src/package-contracts/judge-output.ts";


// validateAcceptedJudgeDetails round-trip: converged exact keys stay unchanged,
// and retained evidence + optional note are lawful on every judge status.
test("accepted judge details round-trip unchanged across statuses and key shapes", () => {
  // Converged exact-keys row: accepted output is returned unchanged (same refs).
  const evidence = {
    checks: [{ name: "settled-audit", passed: true }],
    empty: {},
  } as const;
  const converged = {
    judgeStatus: "converged",
    note: "archive the accepted evidence",
    evidence,
  } as const;
  const acceptedConverged = validateAcceptedJudgeDetails(converged);
  assert.deepEqual(acceptedConverged, converged);
  assert.equal(acceptedConverged.evidence, evidence);

  // Full-state loop: continue/escalate carry optional fix/classes/decisionGate.
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
