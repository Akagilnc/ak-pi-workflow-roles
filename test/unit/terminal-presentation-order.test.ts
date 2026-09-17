/**
 * #961 — public terminal presents same-run submissions newest-first.
 *
 * Typed payloads stay ledger order (ADR 0003 / 0041). Only human presentation
 * rearranges (ADR 0052 / anchoring constitution). Assert content order, never
 * row labels (ADR 0016).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTerminalResult,
  type TerminalResult,
} from "../../src/public-cli/terminal.ts";

test("#961 formatTerminalResult lists newest submission content before older, keeps both", () => {
  const earlier = { judgeStatus: "continue", note: "first-submission-marker-earlier" };
  const later = { judgeStatus: "escalate", note: "second-submission-marker-later" };
  const terminal: TerminalResult = {
    roleOutcome: {
      kind: "accepted",
      role: "judge",
      // Typed face: ledger order (earlier → later).
      payloads: [earlier, later],
    },
    navigator: { disposition: "no-advice" },
    artifacts: [],
    runId: "run-961-presentation",
    submissions: [earlier, later],
  };

  // Typed arrays must remain ledger order — presentation must not mutate them.
  assert.deepEqual(terminal.roleOutcome.kind === "accepted" ? terminal.roleOutcome.payloads : [], [
    earlier,
    later,
  ]);
  assert.deepEqual(terminal.submissions, [earlier, later]);

  const face = formatTerminalResult(terminal);
  assert.ok(face.includes("first-submission-marker-earlier"));
  assert.ok(face.includes("second-submission-marker-later"));
  assert.ok(
    face.indexOf("second-submission-marker-later") < face.indexOf("first-submission-marker-earlier"),
    "newest submission content must appear before older content",
  );
});
