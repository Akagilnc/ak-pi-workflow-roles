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

test("#969 secretariat_verdict routes to countersign and maps countersignStatus",
  async () => {
    const cases = [
      { countersignStatus: "converged", expected: "pass" as const },
      { countersignStatus: "continue", expected: "bounce" as const },
      { countersignStatus: "escalate", expected: "escalate" as const },
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
                payloads: [{ countersignStatus: item.countersignStatus }],
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
        `countersignStatus=${item.countersignStatus}`,
      );
      if (
        projected.result.status === "pass"
        || projected.result.status === "bounce"
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
    const { requireGatekeeperPass } = await import("../../src/gatekeeper-pass-envelope.ts");
    const { COUNTERSIGN_CONCLUSION_REASK } = await import("../../src/gatekeeper-role.ts");
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

test("#969 host trigger boundary: codex/claude/grok-build arm gate; pi does not",
  async () => {
    const { createSecretariatRoleRuntime } = await import("../../src/role-runtime.ts");
    const { SECRETARIAT_OUTPUT_TOOL_NAME } = await import("../../src/secretariat-contracts.ts");
    const { ParentQueueReaskError } = await import("../../src/submission-errors.ts");

    async function arm(host: string | undefined) {
      const gateCalls: string[] = [];
      const tools = new Map<string, { execute: Function }>();
      const roleHost = {
        registerTool(tool: { name: string; execute: Function }) {
          tools.set(tool.name, tool);
        },
        on() {},
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        setActiveTools() {},
        getActiveTools: () => [...tools.keys()],
        getFlag() { return undefined; },
        async requireGatekeeperPass(options: { subject: { kind: string } }) {
          gateCalls.push(options.subject.kind);
        },
      };
      await createSecretariatRoleRuntime(
        roleHost as never,
        { loadSoul: async () => "中书省" },
        {
          failInfrastructure(): never { throw new Error("fail"); },
          bindSubmissionNonPass() {},
        },
      ).activate();
      const ctx = {
        cwd: "/tmp",
        mode: "json",
        model: undefined,
        sessionManager: {} as never,
        runDirectory: "/tmp/run",
        ...(host === undefined ? {} : { host }),
        abort() {},
      };
      await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
        "c",
        { secretariatStatus: "converged", ticketNumber: 969 },
        undefined,
        undefined,
        ctx,
      );
      return gateCalls;
    }

    for (const host of ["codex", "claude", "grok-build"] as const) {
      assert.deepEqual(await arm(host), ["secretariat_verdict"], host);
    }
    assert.deepEqual(await arm("pi"), []);
    assert.deepEqual(await arm(undefined), []);

    // Unknown status on non-pi reasks parent (ADR 0055).
    const tools = new Map<string, { execute: Function }>();
    const roleHost = {
      registerTool(tool: { name: string; execute: Function }) {
        tools.set(tool.name, tool);
      },
      on() {},
      getAllTools: () => [...tools.keys()].map((name) => ({ name })),
      setActiveTools() {},
      getActiveTools: () => [...tools.keys()],
      getFlag() { return undefined; },
      async requireGatekeeperPass() {
        throw new Error("gate must not run");
      },
    };
    await createSecretariatRoleRuntime(
      roleHost as never,
      { loadSoul: async () => "中书省" },
      {
        failInfrastructure(): never { throw new Error("fail"); },
        bindSubmissionNonPass() {},
      },
    ).activate();
    await assert.rejects(
      () =>
        tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
          "bad",
          { secretariatStatus: "unexpected" },
          undefined,
          undefined,
          {
            cwd: "/tmp",
            mode: "json",
            model: undefined,
            sessionManager: {} as never,
            host: "codex",
            abort() {},
          },
        ),
      (error: unknown) => error instanceof ParentQueueReaskError,
    );
  },
);

test("#969 secretariat_verdict escalate throws without bindSubmissionNonPass (end-parent)",
  async () => {
    const { requireGatekeeperPass } = await import("../../src/gatekeeper-pass-envelope.ts");
    const { GatekeeperDecisionError } = await import("../../src/gatekeeper-role.ts");
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
    const { requireGatekeeperPass } = await import("../../src/gatekeeper-pass-envelope.ts");
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
