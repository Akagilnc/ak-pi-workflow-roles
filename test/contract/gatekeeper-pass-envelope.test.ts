/**
 * #969 secretariat↔countersign gate envelope (requireSubmissionGate).
 * Loads archivist-backed envelope — contract tier, not unit (quality-law size).
 * Pure projection cases remain in test/unit/gate-officer-resume-accounting.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { requireSubmissionGate } from "../../src/submission-gate.ts";
import {
  OFFICER_CONCLUSION_REASK,
  GatekeeperDecisionError,
  projectGatekeeperRun,
} from "../../src/gatekeeper-role.ts";
import { OfficerEscalationParkError } from "../../src/submission-errors.ts";

test("#1028 secretariat_verdict reads the shared review status",
  async () => {
    // Shared contract accepts only its three words; shape-invalid remains unreadable.
    const cases: ReadonlyArray<{
      label: string;
      payload: Record<string, unknown>;
      expected: "needs_reask" | "converged" | "continue";
    }> = [
      {
        label: "shared-word disguise status=pass only",
        payload: { status: "pass" },
        expected: "needs_reask",
      },
      {
        label: "shared continue is returned as continue",
        payload: { status: "continue", fix: { summary: "修" } },
        expected: "continue",
      },
      {
        label: "shared converged remains converged",
        payload: { status: "converged", note: "署" },
        expected: "converged",
      },
      {
        label: "unmapped status",
        payload: { status: "maybe" },
        expected: "needs_reask",
      },
      {
        label: "missing discriminator",
        payload: { note: "no status field" },
        expected: "needs_reask",
      },
    ];
    for (const item of cases) {
      const projected = await projectGatekeeperRun({
        context: {
          cwd: process.cwd(),
          sessionManager: { getSessionFile: () => "/tmp/unused" },
        } as never,
        subject: { kind: "secretariat_verdict" },
        runDirectory: "/tmp/runs/01parent@secretariat",
        summonOfficer: async () => ({
          exitCode: 0,
          terminal: {
            roleOutcome: {
              kind: "accepted",
              role: "countersign",
              payloads: [item.payload],
            },
            navigator: { disposition: "no-advice" },
            artifacts: [],
            runId: "countersign-run",
          },
        }),
      });
      assert.equal(projected.result.status, item.expected, item.label);
    }

    // Envelope reask names the single shared status vocabulary.
    const reasks: Array<string | undefined> = [];
    let round = 0;
    await requireSubmissionGate({
      context: {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => "/tmp/unused" },
      } as never,
      subject: { kind: "secretariat_verdict" },
      toolCallId: "t-reask",
      hostActions: {
        failInfrastructure(): never {
          throw new Error("infra");
        },
        bindSubmissionNonPass() {
          throw new Error("reask must not bind non-pass");
        },
      },
      summonOfficer: async (_o, _s, _sig, reask) => {
        reasks.push(reask);
        round += 1;
        const payload =
          round === 1
            ? { status: "pass" }
            : { status: "converged", note: "署 after reask" };
        return {
          exitCode: 0,
          runDirectory: "/tmp/runs/01a0cs969-reask-7000-8000-000000000001@countersign",
          terminal: {
            roleOutcome: {
              kind: "accepted",
          role: "countersign",
          payloads: [payload],
            },
            navigator: { disposition: "no-advice" },
            artifacts: [],
            runId: "01a0cs969-reask-7000-8000-000000000001",
          },
        };
      },
    });
    assert.equal(reasks[0], undefined, "first summon has no reask");
    assert.equal(reasks[1], OFFICER_CONCLUSION_REASK);
  },
);

test("#969 secretariat_verdict escalate throws without bindSubmissionNonPass (end-parent)",
  async () => {
    const nonPass: unknown[] = [];
    const receipt = {
      status: "escalate",
      decisionGate: { question: "q", options: ["a"] },
    };
    let thrown: unknown;
    await assert.rejects(
      () =>
        requireSubmissionGate({
          context: {
            cwd: process.cwd(),
            sessionManager: { getSessionFile: () => "/tmp/unused" },
          } as never,
          subject: { kind: "secretariat_verdict" },
          toolCallId: "t1",
          hostActions: {
            failInfrastructure(): never {
              throw new Error("infra");
            },
            bindSubmissionNonPass(_id, result) {
              nonPass.push(result);
            },
          },
          summonOfficer: async () => ({
            exitCode: 0,
            runDirectory: "/tmp/runs/01a0cs969-esc-7000-8000-000000000099@countersign",
            terminal: {
              roleOutcome: {
                kind: "accepted",
                role: "countersign",
                payloads: [receipt],
              },
              navigator: { disposition: "no-advice" },
              artifacts: [],
              runId: "01a0cs969-esc-7000-8000-000000000099",
            },
          }),
        }),
      (error: unknown) => {
        thrown = error;
        return (
          error instanceof OfficerEscalationParkError
          && error.result.status === "escalate"
        );
      },
    );
    assert.equal(nonPass.length, 0, "escalate must not arm parent retry bind");
    assert.ok(thrown instanceof OfficerEscalationParkError);
    assert.equal(thrown.result.status, "escalate");
    assert.equal(
      thrown.result.status === "escalate" ? thrown.result.runId : undefined,
      "01a0cs969-esc-7000-8000-000000000099",
      "escalate result must carry nested runId",
    );
  },
);


test("#969 requireSubmissionGate pass returns receipt + nested runId",
  async () => {
    const receipt = { status: "converged", note: "署" };
    const outcome = await requireSubmissionGate({
      context: {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => "/tmp/unused" },
      } as never,
      subject: { kind: "secretariat_verdict" },
      toolCallId: "t-pass",
      hostActions: {
        failInfrastructure(): never {
          throw new Error("infra");
        },
        bindSubmissionNonPass() {
          throw new Error("pass must not bind non-pass");
        },
      },
      summonOfficer: async () => ({
        exitCode: 0,
        runDirectory: "/tmp/runs/01a0cs969-pass-7000-8000-000000000042@countersign",
        terminal: {
          roleOutcome: {
            kind: "accepted",
            role: "countersign",
            payloads: [receipt],
          },
          navigator: { disposition: "no-advice" },
          artifacts: [],
          runId: "01a0cs969-pass-7000-8000-000000000042",
        },
      }),
    });
    assert.ok(outcome !== undefined && outcome !== null);
    assert.equal(outcome!.officer, "countersign");
    assert.deepEqual(outcome!.receipt, receipt);
    assert.equal(outcome!.runId, "01a0cs969-pass-7000-8000-000000000042");
  },
);
