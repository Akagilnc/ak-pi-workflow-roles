/**
 * #836 / #879 class: gate-officer same-parent resume + gate-round accounting (pure projection).
 * - Host abort coexists with recorded officer payload (#836).
 * - This-court officer receipt from settlement payloads only — no sole-row guess.
 * - Undivided submissions without scoped payloads are not this-court identity.
 * - Non-three-state then lawful pass: parent sees this-court pass only.
 * - #969 secretariat_verdict → countersign status map (projection only).
 * Envelope / role-runtime #969 cases (archivist + runtime load):
 * test/contract/submission-gate.test.ts,
 * test/contract/secretariat-role.test.ts.
 * Medium FS #753 / #821 / #879 Nth-turn / court-scope; #1092 no dossier delivery:
 * test/integration/gate-officer-resume-accounting.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";

test("#836 host abort coexists with recorded officer payload — does not wash to bounce", async () => {
  const bounce = { status: "continue", findings: ["keep-me"] };
  const diagnostic = "This operation was aborted";
  const projected = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "notary",
          cause: "output",
          diagnostic,
          decisiveFacts: { cause: "output" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [bounce],
      },
    }),
  });
  assert.equal(projected.result.status, "transport_failure");
  if (projected.result.status === "transport_failure") {
    assert.equal(projected.result.reason, diagnostic);
    assert.deepEqual(projected.result.submission, [bounce]);
  }
});

test("#879 undivided submissions without scoped payloads are not this-court identity", async () => {
  const multi = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: "notary",
          status: "continue",
          decisiveFacts: { status: "continue" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "converged", findings: ["first"] },
          { status: "continue", findings: ["second"] },
        ],
      },
    }),
  });
  assert.equal(multi.result.status, "continue");
  if (multi.result.status === "continue") {
    assert.notDeepEqual(
      multi.result.receipt,
      { status: "continue", findings: ["second"] },
      "must not last-wins undivided multi-row submissions",
    );
  }

  const sole = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: "notary",
          status: "converged",
          decisiveFacts: { status: "converged" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [{ status: "converged", findings: ["only"] }],
      },
    }),
  });
  assert.equal(sole.result.status, "converged");
  if (sole.result.status === "converged") {
    assert.notDeepEqual(
      sole.result.receipt,
      { status: "converged", findings: ["only"] },
      "must not guess sole unbound submissions row as this-court receipt",
    );
  }
});

test("#879 non-three-state then lawful pass converges; parent sees this-court pass only", async () => {
  const thisCourt = { status: "converged", findings: ["ok"] };
  const projected = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: "notary",
          payloads: [thisCourt],
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "other", note: "first" },
          thisCourt,
        ],
      },
    }),
  });
  assert.equal(projected.result.status, "converged");
  if (projected.result.status === "converged") {
    assert.deepEqual(projected.result.receipt, thisCourt);
  }
  assert.deepEqual(projected.summoned?.terminal?.submissions, [
    { status: "other", note: "first" },
    thisCourt,
  ]);
});

test("#969 secretariat_verdict routes to countersign and maps status",
  async () => {
    const cases = [
      { status: "converged", expected: "converged" as const },
      { status: "continue", expected: "continue" as const },
      { status: "escalate", expected: "escalate" as const },
    ];
    for (const item of cases) {
      const projected = await projectGatekeeperRun({
        context: {
          cwd: process.cwd(),
          sessionManager: { getSessionFile: () => "/tmp/unused" },
        } as never,
        subject: { kind: "secretariat_verdict" },
        runDirectory: "/tmp/runs/01parent@secretariat",
        submission: { secretariatStatus: "converged", ticketNumber: 969 },
        summonOfficer: async (officer, _source, _signal, _reask, submission) => {
          assert.equal(officer, "countersign");
          assert.deepEqual(submission, {
            secretariatStatus: "converged",
            ticketNumber: 969,
          });
          return {
            exitCode: 0,
            runDirectory: "/tmp/runs/01a0cs969-nest-7000-8000-000000000001@countersign",
            terminal: {
              roleOutcome: {
                kind: "accepted",
                role: "countersign",
                payloads: [{ status: item.status }],
              },
              navigator: { disposition: "no-advice" },
              artifacts: [],
              runId: "01a0cs969-nest-7000-8000-000000000001",
            },
          };
        },
      });
      assert.equal(projected.officer, "countersign");
      assert.equal(
        projected.result.status,
        item.expected,
        `status=${item.status}`,
      );
      if (
        projected.result.status === "converged"
        || projected.result.status === "continue"
        || projected.result.status === "escalate"
      ) {
        assert.equal(
          projected.result.runId,
          "01a0cs969-nest-7000-8000-000000000001",
          "officer projection must carry nested runId from summoned.runDirectory",
        );
      }
    }
  },
);
