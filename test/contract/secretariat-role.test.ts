/**
 * #924 Secretariat (中书省) — envelope-assembled tools + nested countersign summon.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
  projectSecretariatSummonResult,
} from "../../src/secretariat-role.ts";
import { createSecretariatRoleRuntime } from "../../src/role-runtime.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { ParentQueueReaskError } from "../../src/submission-errors.ts";

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
  readonly activeTools: () => readonly string[];
};

async function activateSecretariat(options?: {
  summonCountersign?: (input: {
    readonly instruction: string;
    readonly cwd: string;
    readonly correlationId?: string;
  }) => Promise<PublicSummonResult>;
  /** Optional pre-existing host-surface tool names (no Pi-name hardcode in role). */
  readonly hostSurfaceTools?: readonly string[];
  readonly activationCount?: number;
}): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  let active: string[] = [...(options?.hostSurfaceTools ?? [])];
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      const packageNames = [...tools.values()].map((t) => ({ name: t.name }));
      const hostOnly = (options?.hostSurfaceTools ?? [])
        .filter((name) => !tools.has(name))
        .map((name) => ({ name }));
      return [...hostOnly, ...packageNames];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
    getActiveTools() {
      return [...active];
    },
    getFlag() {
      return undefined;
    },
  };
  const runtime = createSecretariatRoleRuntime(roleHost as never, {
    loadSoul: async () => "中书省法",
    packageRoot: "/pkg",
    ...(options?.summonCountersign === undefined
      ? {}
      : { summonCountersign: options.summonCountersign as never }),
  });
  for (let i = 0; i < (options?.activationCount ?? 1); i += 1) {
    await runtime.activate();
  }
  return { tools, activeTools: () => active };
}

const ctx = {
  cwd: "/work",
  mode: "json",
  model: undefined,
  sessionManager: {} as never,
  runDirectory: "/home/books/x/runs/01parent@secretariat",
  abort() {},
};

test("secretariat activation and reload declare package tools on active surface (G6)", async () => {
  const { activeTools } = await activateSecretariat({
    hostSurfaceTools: ["host_read", "host_shell"],
    activationCount: 2,
  });
  const active = activeTools();
  assert.ok(active.includes(SECRETARIAT_OUTPUT_TOOL_NAME));
  assert.ok(active.includes(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME));
  // Host surface preserved without role hardcoding builtin names.
  assert.ok(active.includes("host_read"));
  assert.ok(active.includes("host_shell"));
});

test("secretariat output records any status without shape reject (第 0 条)", async () => {
  const { tools } = await activateSecretariat();
  const converged = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c1",
    { secretariatStatus: "converged", ticketNumber: 924 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(converged.terminate, true);
  assert.equal(
    (converged.details as { secretariatStatus: string }).secretariatStatus,
    "converged",
  );

  const escalated = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c2",
    {
      secretariatStatus: "escalate",
      decisionGate: { question: "拆不拆席？", options: ["暂不", "拆"] },
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(escalated.terminate, true);
  assert.equal(
    (escalated.details as { secretariatStatus: string }).secretariatStatus,
    "escalate",
  );

  // 第 0 条 / #924: tool only records; non-canonical status is not code-rejected.
  const other = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c3",
    { secretariatStatus: "unexpected" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(other.terminate, true);
  assert.equal(
    (other.details as { secretariatStatus: string }).secretariatStatus,
    "unexpected",
  );
});

test("secretariat summon-countersign calls shared seam with parent correlation", async () => {
  const calls: Array<{
    instruction: string;
    cwd: string;
    correlationId?: string;
  }> = [];
  const { tools } = await activateSecretariat({
    summonCountersign: async (input) => {
      calls.push({
        instruction: input.instruction,
        cwd: input.cwd,
        ...(input.correlationId === undefined
          ? {}
          : { correlationId: input.correlationId }),
      });
      return {
        exitCode: 0,
        runDirectory: "/home/books/x/runs/01child@countersign",
        terminal: {
          roleOutcome: {
            kind: "accepted",
            role: "countersign",
            payloads: [{ countersignStatus: "converged", note: "署" }],
          },
        } as never,
      };
    },
  });
  const result = await tools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME)!.execute(
    "summon-1",
    { instruction: "裁：#924 是否足以开工。" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.terminate, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.instruction, "裁：#924 是否足以开工。");
  assert.equal(calls[0]!.cwd, "/work");
  assert.equal(calls[0]!.correlationId, "01parent");
  const details = result.details as {
    outcomeKind?: string;
    countersignStatus?: string;
    runId?: string;
  };
  assert.equal(details.outcomeKind, "accepted");
  assert.equal(details.countersignStatus, "converged");
  assert.equal(details.runId, "01child");
});

/**
 * #953: real ak_secretariat_summon_countersign execute entry — six terminal
 * kinds on typed details only. Parent-visible text reuses readableGateItem on
 * those details in role-runtime (static review); do not lock generated text.
 */
test("secretariat summon tool delivers typed parent facts for each terminal kind", async () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly summoned: PublicSummonResult;
    readonly expect: {
      readonly outcomeKind: string;
      readonly runId?: string;
      readonly detailsCheck?: (details: Record<string, unknown>) => void;
    };
  }> = [
    {
      label: "continue",
      summoned: {
        exitCode: 0,
        runDirectory: "/r/01cont@countersign",
        terminal: {
          roleOutcome: {
            kind: "accepted",
            role: "countersign",
            status: "continue",
            payloads: [{ countersignStatus: "continue", fix: { summary: "rework" } }],
          },
        } as never,
      },
      expect: {
        outcomeKind: "accepted",
        runId: "01cont",
        detailsCheck: (details) => {
          assert.equal(details.countersignStatus, "continue");
          assert.deepEqual(details.receipt, {
            countersignStatus: "continue",
            fix: { summary: "rework" },
          });
        },
      },
    },
    {
      label: "converged",
      summoned: {
        exitCode: 0,
        runDirectory: "/r/01conv@countersign",
        terminal: {
          roleOutcome: {
            kind: "accepted",
            role: "countersign",
            payloads: [{ countersignStatus: "converged", note: "seal" }],
          },
        } as never,
      },
      expect: {
        outcomeKind: "accepted",
        runId: "01conv",
        detailsCheck: (details) => {
          assert.equal(details.countersignStatus, "converged");
        },
      },
    },
    {
      label: "escalate",
      summoned: {
        exitCode: 0,
        runDirectory: "/r/01esc@countersign",
        terminal: {
          roleOutcome: {
            kind: "audit_escalation",
            role: "countersign",
            status: "audit_escalation",
            payloads: [
              { countersignStatus: "escalate", decisionGate: { question: "split?" } },
            ],
            decisiveFacts: { gate: "open" },
          },
        } as never,
      },
      expect: {
        outcomeKind: "audit_escalation",
        runId: "01esc",
        detailsCheck: (details) => {
          assert.equal(details.countersignStatus, "escalate");
          assert.deepEqual(details.decisiveFacts, { gate: "open" });
        },
      },
    },
    {
      label: "failure",
      summoned: {
        exitCode: 1,
        runDirectory: "/r/01fail@countersign",
        terminal: {
          roleOutcome: {
            kind: "failure",
            role: "countersign",
            diagnostic: "nested boom",
            cause: "provider",
            decisiveFacts: { cause: "provider" },
          },
          // #953: history on submissions carrier — not failure.payloads/receipt.
          submissions: [
            {
              countersignStatus: "continue",
              findings: [{ article: "old", reason: "prior" }],
            },
          ],
        } as never,
      },
      expect: {
        outcomeKind: "failure",
        runId: "01fail",
        detailsCheck: (details) => {
          assert.equal(details.diagnostic, "nested boom");
          assert.equal(details.cause, "provider");
          assert.equal(details.receipt, undefined);
          assert.equal(details.payloads, undefined);
          assert.deepEqual(details.submissions, [
            {
              countersignStatus: "continue",
              findings: [{ article: "old", reason: "prior" }],
            },
          ]);
        },
      },
    },
    {
      label: "no_receipt",
      summoned: {
        exitCode: 0,
        runDirectory: "/r/01norec@countersign",
        stderr: "quiet",
        terminal: {
          roleOutcome: {
            kind: "no_receipt",
            role: "countersign",
            status: "no-accepted-receipt",
            decisiveFacts: { acceptedReceipt: false },
          },
        } as never,
      },
      expect: {
        outcomeKind: "no_receipt",
        runId: "01norec",
        detailsCheck: (details) => {
          assert.equal(details.status, "no-accepted-receipt");
          assert.equal(details.stderr, "quiet");
        },
      },
    },
    {
      label: "no_terminal",
      summoned: {
        exitCode: 1,
        runDirectory: "/r/01noterm@countersign",
        stderr: "died before terminal",
      },
      expect: {
        outcomeKind: "no_terminal",
        runId: "01noterm",
        detailsCheck: (details) => {
          assert.equal(details.exitCode, 1);
          assert.equal(details.stderr, "died before terminal");
        },
      },
    },
  ];

  for (const row of cases) {
    const { tools } = await activateSecretariat({
      summonCountersign: async () => row.summoned,
    });
    const result = await tools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME)!.execute(
      `summon-${row.label}`,
      { instruction: `case ${row.label}` },
      undefined,
      undefined,
      ctx,
    );
    const details = result.details as Record<string, unknown>;
    assert.equal(details.outcomeKind, row.expect.outcomeKind, row.label);
    if (row.expect.runId !== undefined) {
      assert.equal(details.runId, row.expect.runId, row.label);
    }
    row.expect.detailsCheck?.(details);
  }
});

test("projectSecretariatSummonResult keeps multi-receipt latest as receipt", () => {
  const multi = projectSecretariatSummonResult({
    exitCode: 0,
    runDirectory: "/r/01multi@countersign",
    terminal: {
      roleOutcome: {
        kind: "accepted",
        role: "countersign",
        payloads: [
          { countersignStatus: "continue", fix: { summary: "bounce" } },
          { countersignStatus: "converged", note: "seal" },
        ],
      },
    } as never,
  });
  assert.equal(multi.outcomeKind, "accepted");
  assert.equal(multi.runId, "01multi");
  assert.equal(multi.countersignStatus, "converged");
  assert.deepEqual(multi.payloads, [
    { countersignStatus: "continue", fix: { summary: "bounce" } },
    { countersignStatus: "converged", note: "seal" },
  ]);
  assert.deepEqual(multi.receipt, {
    countersignStatus: "converged",
    note: "seal",
  });
});

test("#969 host trigger boundary: codex/claude/grok-build arm gate; pi does not",
  async () => {
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
      const hostCtx = {
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
        hostCtx,
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
