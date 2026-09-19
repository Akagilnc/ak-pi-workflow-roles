/**
 * #969 secretariat↔countersign gate envelope (requireGatekeeperPass).
 * Loads archivist-backed envelope — contract tier, not unit (quality-law size).
 * Pure projection cases remain in test/unit/gate-officer-resume-accounting.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { requireGatekeeperPass } from "../../src/gatekeeper-pass-envelope.ts";
import {
  COUNTERSIGN_CONCLUSION_REASK,
  GatekeeperDecisionError,
  projectGatekeeperRun,
} from "../../src/gatekeeper-role.ts";

test("#969 secretariat_verdict unreadable countersignStatus needs_reask",
  async () => {
    // Shared-word disguise / field conflict / unmapped / missing on the existing
    // mapping fixture — never fall back to generic status (#969 / ADR 0055).
    const cases: ReadonlyArray<{
      label: string;
      payload: Record<string, unknown>;
      expected: "needs_reask" | "bounce";
    }> = [
      {
        label: "shared-word disguise status=pass only",
        payload: { status: "pass" },
        expected: "needs_reask",
      },
      {
        label: "field conflict: only countersignStatus maps (continue→bounce)",
        payload: { status: "pass", countersignStatus: "continue" },
        expected: "bounce",
      },
      {
        label: "unmapped countersignStatus",
        payload: { countersignStatus: "maybe" },
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

    // Envelope reask must name countersignStatus three-state words, not pass/bounce.
    const reasks: Array<string | undefined> = [];
    let round = 0;
    await requireGatekeeperPass({
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
            : { countersignStatus: "converged", note: "署 after reask" };
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
    assert.equal(reasks[1], COUNTERSIGN_CONCLUSION_REASK);
    assert.match(reasks[1] ?? "", /converged、continue、escalate/);
    assert.doesNotMatch(reasks[1] ?? "", /pass、bounce/);
  },
);

test("#969 secretariat_verdict escalate throws without bindSubmissionNonPass (end-parent)",
  async () => {
    const nonPass: unknown[] = [];
    const receipt = {
      countersignStatus: "escalate",
      decisionGate: { question: "q", options: ["a"] },
    };
    let thrown: unknown;
    await assert.rejects(
      () =>
        requireGatekeeperPass({
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
          error instanceof GatekeeperDecisionError
          && error.result.status === "escalate"
        );
      },
    );
    assert.equal(nonPass.length, 0, "escalate must not arm parent retry bind");
    assert.ok(thrown instanceof GatekeeperDecisionError);
    assert.equal(thrown.result.status, "escalate");
    assert.equal(
      thrown.result.status === "escalate" ? thrown.result.runId : undefined,
      "01a0cs969-esc-7000-8000-000000000099",
      "escalate result must carry nested runId",
    );
  },
);

test("#969 requireGatekeeperPass pass returns receipt + nested runId",
  async () => {
    const receipt = { countersignStatus: "converged", note: "署" };
    const outcome = await requireGatekeeperPass({
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
