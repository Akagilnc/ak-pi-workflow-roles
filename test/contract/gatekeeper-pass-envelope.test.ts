/**
 * #969 secretariat↔countersign gate envelope (requireSubmissionGate).
 * Loads archivist-backed envelope — contract tier, not unit (quality-law size).
 * Pure projection cases remain in test/unit/gate-officer-resume-accounting.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { requireSubmissionGate } from "../../src/submission-gate.ts";
import { sessionFileOf } from "../../src/role-run-placement.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { readHistoryRows } from "../helpers/run-dossier-fixture.ts";
import {
  projectGatekeeperRun,
} from "../../src/gatekeeper-role.ts";

/** A parent run inside a ledger home: the appender only books records for a real run leaf. */
function parentRunDirectory(root: string): string {
  return `${root}/.ak-roles/books/gate-envelope/runs/01a0cs969-parent-7000-8000-000000000001@judge`;
}

test("#1028 secretariat_verdict reads the shared review status",
  async () => {
    // Shared contract accepts only its three words; shape-invalid remains unreadable.
    const cases: ReadonlyArray<{
      label: string;
      payload: Record<string, unknown>;
      expected: "needs_reask" | "converged" | "continue" | "escalate";
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
      {
        label: "failure declaration with escalate stays escalate",
        payload: { status: "escalate", infrastructureFailure: { diagnostic: "disk full" } },
        expected: "escalate",
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
      if ("infrastructureFailure" in item.payload) {
        const receipt = "receipt" in projected.result ? projected.result.receipt : undefined;
        assert.equal(
          receipt !== null && typeof receipt === "object" && !Array.isArray(receipt)
            ? (receipt as { infrastructureFailure?: { diagnostic?: unknown } }).infrastructureFailure?.diagnostic
            : undefined,
          "disk full",
          item.label,
        );
      }
    }


    const compatProjected = await projectGatekeeperRun({
      context: {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => "/tmp/unused" },
      } as never,
      subject: { kind: "secretariat_verdict" },
      runDirectory: "/tmp/runs/parent",
      summonOfficer: async () => ({
        exitCode: 0,
        runDirectory: "/tmp/runs/01a0cs969-compat-7000-8000-000000000001@countersign",
        terminal: {
          roleOutcome: { kind: "accepted", role: "countersign", status: "other" },
          navigator: { disposition: "no-advice" },
          artifacts: [],
          runId: "01a0cs969-compat-7000-8000-000000000001",
        },
      }),
    });
    assert.equal(compatProjected.result.status, "needs_reask");
    assert.equal(
      compatProjected.result.status === "needs_reask" ? compatProjected.result.receivedStatus : undefined,
      "other",
    );
    assert.equal(
      compatProjected.result.status === "needs_reask" ? compatProjected.result.receipt : "forged",
      undefined,
    );
  },
);

test("#969 secretariat_verdict returns escalation for direct officer resume",
  async () => withTempRoot("ak-gate-envelope-", async (root) => {
    const parentRun = parentRunDirectory(root);
    const nonPass: unknown[] = [];
    const receipt = {
      status: "escalate",
      decisionGate: { question: "q", options: ["a"] },
    };
    const outcome = await requireSubmissionGate({
      context: {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => sessionFileOf(parentRun) },
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
    });
    assert.equal(nonPass.length, 0, "escalate must not arm parent retry bind");
    // #1195: parent no longer books officer-pointer copies; resume uses officer runId.
    const booked = readHistoryRows(parentRun).filter((row) => row.kind === "officer-pointer");
    assert.equal(booked.length, 0, "parent history must not book officer-pointer rows");
    assert.equal(outcome?.status, "escalate");
    assert.equal(outcome && "officer" in outcome ? outcome.officer : undefined, "countersign");
    assert.deepEqual(outcome && "receipt" in outcome ? outcome.receipt : undefined, receipt);
    assert.equal(outcome && "runId" in outcome ? outcome.runId : undefined, "01a0cs969-esc-7000-8000-000000000099");
    assert.equal(
      outcome && "runDirectory" in outcome ? outcome.runDirectory : undefined,
      "/tmp/runs/01a0cs969-esc-7000-8000-000000000099@countersign",
    );
    // #1195: escalate keeps the nested terminal so outer parents retain attached facts.
    assert.ok(outcome && "terminal" in outcome && outcome.terminal !== undefined);
  }),
);


test("#969 requireSubmissionGate pass returns receipt + nested runId",
  async () => withTempRoot("ak-gate-envelope-", async (root) => {
    const parentRun = parentRunDirectory(root);
    const receipt = { status: "converged", note: "署" };
    const outcome = await requireSubmissionGate({
      context: {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => sessionFileOf(parentRun) },
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
  }),
);

test("#1214 A5: officer transport_failure returns honestly; does not failInfrastructure parent",
  async () => withTempRoot("ak-gate-envelope-", async (root) => {
    const parentRun = parentRunDirectory(root);
    let infraCalls = 0;
    const officerTerminal = {
      roleOutcome: {
        kind: "failure" as const,
        role: "notary" as const,
        diagnostic: "officer host failed",
        decisiveFacts: {},
      },
      navigator: { disposition: "no-advice" as const },
      artifacts: [] as const,
      runId: "01a01214-fail-7000-8000-000000000099",
    };
    const outcome = await requireSubmissionGate({
      context: {
        cwd: process.cwd(),
        sessionManager: { getSessionFile: () => sessionFileOf(parentRun) },
      } as never,
      subject: { kind: "judge_draft" },
      toolCallId: "t-transport",
      hostActions: {
        failInfrastructure(): never {
          infraCalls += 1;
          throw new Error("infra must not run for transport_failure");
        },
        bindSubmissionNonPass() {
          throw new Error("transport_failure returns as outcome; no non-pass bind");
        },
      },
      summonOfficer: async () => ({
        exitCode: 1,
        stderr: "officer host failed",
        runDirectory: "/tmp/runs/01a01214-fail-7000-8000-000000000099@notary",
        terminal: officerTerminal,
      }),
    });
    assert.equal(infraCalls, 0, "A5: transport_failure must not call failInfrastructure");
    assert.equal(outcome?.status, "transport_failure");
    assert.equal(outcome && "officer" in outcome ? outcome.officer : undefined, "notary");
    assert.equal(
      outcome && "runId" in outcome ? outcome.runId : undefined,
      "01a01214-fail-7000-8000-000000000099",
    );
    assert.ok(outcome && "terminal" in outcome && outcome.terminal !== undefined);
    assert.equal(outcome?.terminal?.roleOutcome.kind, "failure");
  }),
);
