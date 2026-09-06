/**
 * Parent-side contracts of a nested public summon (#675).
 *
 * 1. A nested summon is an in-process await over a child activation: the parent's
 *    cancellation must reach that child. The terminating seam itself (child
 *    SIGTERM) is traced in test/integration/public-cli-explicit-internal.test.ts.
 * 2. Settlement's shape-unreadable marker decides by presence, not by the retained
 *    candidate value: an omitted-arguments role call is an unreadable decision the
 *    parent stands on, never an infrastructure rethrow (ADR 0055 / CLAUDE.md §0).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runComplianceAudit } from "../../src/compliance-transport.ts";
import { stampShapeUnreadableDetails } from "../../src/shape-unreadable-failure.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import type { HostContext } from "../../src/host-contracts.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

function acceptedSummon(role: "notary" | "auditor", status: string): PublicSummonResult {
  return {
    exitCode: 0,
    terminal: {
      roleOutcome: {
        kind: "accepted",
        role,
        status,
        decisiveFacts: { status },
      },
      navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
      artifacts: [],
      runId: `test-${role}`,
    },
  };
}

test("gate and compliance summons hand the parent cancellation to the nested activation", async () => {
  await withTempRoot("nested-summon-cancellation-", async (runDirectory) => {
    const context = { cwd: runDirectory } as unknown as HostContext;
    const parent = new AbortController();

    let officerSignal: AbortSignal | undefined;
    const gate = await projectGatekeeperRun({
      context,
      subject: { kind: "judge_draft" },
      runDirectory,
      signal: parent.signal,
      summonOfficer: async (_officer, _sourceRunDirectory, signal) => {
        officerSignal = signal;
        return acceptedSummon("notary", "pass");
      },
    });
    assert.equal(gate.result.status, "pass");
    assert.equal(officerSignal, parent.signal);

    let auditorSignal: AbortSignal | undefined;
    const audit = await runComplianceAudit({
      subject: "judge",
      context,
      runDirectory,
      signal: parent.signal,
      summonAuditor: async (_subject, _sourceRunDirectory, signal) => {
        auditorSignal = signal;
        return acceptedSummon("auditor", "pass");
      },
    });
    assert.equal(audit.status, "pass");
    assert.equal(auditorSignal, parent.signal);
  });
});

test("an omitted-arguments auditor call stays a stood-on unreadable decision", async () => {
  await withTempRoot("nested-summon-unreadable-", async (runDirectory) => {
    const decision = await runComplianceAudit({
      subject: "judge",
      context: { cwd: runDirectory } as unknown as HostContext,
      runDirectory,
      // Settlement stamps the omitted tool-call arguments it retained: marker present,
      // candidate undefined.
      summonAuditor: async () => ({
        exitCode: 1,
        terminal: {
          roleOutcome: {
            kind: "failure",
            role: "auditor",
            cause: "output",
            diagnostic: "auditor 决议无可读形状",
            decisiveFacts: stampShapeUnreadableDetails(undefined),
          },
          navigator: { disposition: "unavailable", source: "unknown", reason: "test" },
          artifacts: [],
          runId: "test-auditor-unreadable",
        },
      }),
    });
    assert.equal(decision.status, "unreadable");
    if (decision.status === "unreadable") {
      assert.deepEqual(decision.observation, { kind: "non-object-arguments", type: "undefined" });
      assert.equal(decision.candidate, undefined);
    }
  });
});
