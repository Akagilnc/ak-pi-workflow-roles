/**
 * #836 / #879 class: gate-officer same-parent resume + gate-round accounting (pure projection).
 * - Host abort coexists with recorded officer payload (#836).
 * - This-court officer receipt from settlement payloads only — no sole-row guess.
 * - Undivided submissions without scoped payloads are not this-court identity.
 * - Non-three-state then lawful pass: parent sees this-court pass only.
 * - Station-child officer promptWithPriorNativePaths omits prior paths.
 * Medium FS #753 / #821 / #879 Nth-turn / court-scope / dossier fold:
 * test/integration/gate-officer-resume-accounting.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import { promptWithPriorNativePaths } from "../../src/external-host-turn-loop.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

function stubRoleTurn(input: {
  readonly role: "notary" | "judge";
  readonly prompt: string;
  readonly priorNativePaths: readonly string[];
  readonly stationChild?: boolean;
}): RoleTurnRequest {
  return {
    principal: fixturePrincipal("/tmp/session"),
    activation:
      input.role === "notary"
        ? { role: "notary", sourceRun: "/tmp/parent" }
        : { role: "judge" },
    methods: [],
    continuation: { kind: "resume", prompt: input.prompt },
    cwd: "/tmp",
    home: "/tmp",
    agentDir: "/tmp/agent",
    runDirectory: "/tmp/run",
    hostTransition: {
      priorNativeKind: "sitian",
      priorNativePaths: input.priorNativePaths,
    },
    ...(input.stationChild === undefined ? {} : { stationChild: input.stationChild }),
  };
}

test("#836 host abort coexists with recorded officer payload — does not wash to bounce", async () => {
  const bounce = { status: "bounce", findings: ["keep-me"] };
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
          diagnostic: "This operation was aborted",
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
    assert.match(projected.result.reason, /This operation was aborted/);
    assert.deepEqual(projected.result.submission, [bounce]);
  }
});

test("#879 this-court receipt from settlement payloads; history stays on submissions", async () => {
  const thisCourt = { status: "bounce", findings: ["second"] };
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
          { status: "pass", findings: ["first"] },
          thisCourt,
        ],
      },
    }),
  });
  assert.equal(projected.result.status, "bounce");
  if (projected.result.status === "bounce") {
    assert.deepEqual(projected.result.receipt, thisCourt);
  }
  assert.deepEqual(projected.summoned?.terminal?.submissions, [
    { status: "pass", findings: ["first"] },
    thisCourt,
  ]);
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
          status: "bounce",
          decisiveFacts: { status: "bounce" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "pass", findings: ["first"] },
          { status: "bounce", findings: ["second"] },
        ],
      },
    }),
  });
  assert.equal(multi.result.status, "bounce");
  if (multi.result.status === "bounce") {
    assert.notDeepEqual(
      multi.result.receipt,
      { status: "bounce", findings: ["second"] },
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
          status: "pass",
          decisiveFacts: { status: "pass" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [{ status: "pass", findings: ["only"] }],
      },
    }),
  });
  assert.equal(sole.result.status, "pass");
  if (sole.result.status === "pass") {
    assert.notDeepEqual(
      sole.result.receipt,
      { status: "pass", findings: ["only"] },
      "must not guess sole unbound submissions row as this-court receipt",
    );
  }
});

test("#879 non-three-state then lawful pass converges; parent sees this-court pass only", async () => {
  const thisCourt = { status: "pass", findings: ["ok"] };
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
  assert.equal(projected.result.status, "pass");
  if (projected.result.status === "pass") {
    assert.deepEqual(projected.result.receipt, thisCourt);
  }
  assert.deepEqual(projected.summoned?.terminal?.submissions, [
    { status: "other", note: "first" },
    thisCourt,
  ]);
});

test("#879 promptWithPriorNativePaths: station-child officer omits paths; others append", () => {
  const prior = "/tmp/prior-sitian.jsonl";
  const peer = "PEER-BODY-TRANSITION-DIFF";
  const appended = `${peer}\n${prior}`;

  assert.equal(
    promptWithPriorNativePaths(
      peer,
      stubRoleTurn({ role: "notary", prompt: peer, priorNativePaths: [prior], stationChild: true }),
    ),
    peer,
    "station-child officer must not splice priorNativePaths",
  );
  assert.equal(
    promptWithPriorNativePaths(
      peer,
      stubRoleTurn({ role: "judge", prompt: peer, priorNativePaths: [prior] }),
    ),
    appended,
    "non-officer must append priorNativePaths",
  );
  assert.equal(
    promptWithPriorNativePaths(
      peer,
      stubRoleTurn({ role: "notary", prompt: peer, priorNativePaths: [prior] }),
    ),
    appended,
    "officer without stationChild must append priorNativePaths",
  );
  assert.equal(
    promptWithPriorNativePaths(
      peer,
      stubRoleTurn({ role: "notary", prompt: peer, priorNativePaths: [prior], stationChild: false }),
    ),
    appended,
    "officer with stationChild false must append priorNativePaths",
  );
});
