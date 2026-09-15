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
import { ParentQueueReaskError } from "../../src/submission-errors.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
};

async function activateSecretariat(options?: {
  summonCountersign?: (input: {
    readonly instruction: string;
    readonly cwd: string;
    readonly correlationId?: string;
  }) => Promise<PublicSummonResult>;
}): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      return [...tools.values()].map((t) => ({ name: t.name }));
    },
    getFlag() {
      return undefined;
    },
  };
  await createSecretariatRoleRuntime(roleHost as never, {
    loadSoul: async () => "中书省法",
    packageRoot: "/pkg",
    ...(options?.summonCountersign === undefined
      ? {}
      : { summonCountersign: options.summonCountersign as never }),
  }).activate();
  return { tools };
}

const ctx = {
  cwd: "/work",
  mode: "json",
  model: undefined,
  sessionManager: {} as never,
  runDirectory: "/home/books/x/runs/01parent@secretariat",
  abort() {},
};

test("secretariat output accepts sealed and escalate; other status reasks", async () => {
  const { tools } = await activateSecretariat();
  const sealed = await tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
    "c1",
    { secretariatStatus: "sealed", ticketNumber: 924 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(sealed.terminate, true);
  assert.equal(
    (sealed.details as { secretariatStatus: string }).secretariatStatus,
    "sealed",
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

  await assert.rejects(
    () =>
      tools.get(SECRETARIAT_OUTPUT_TOOL_NAME)!.execute(
        "c3",
        { secretariatStatus: "continue" },
        undefined,
        undefined,
        ctx,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ParentQueueReaskError);
      return true;
    },
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

test("projectSecretariatSummonResult keeps typed terminal kinds (gatekeeper precedent)", () => {
  const accepted = projectSecretariatSummonResult({
    exitCode: 0,
    runDirectory: "/r/01a@countersign",
    terminal: {
      roleOutcome: {
        kind: "accepted",
        role: "countersign",
        status: "continue",
        payloads: [{ countersignStatus: "continue", fix: { summary: "x" } }],
        decisiveFacts: { note: "accepted-facts" },
      },
    } as never,
  });
  assert.equal(accepted.outcomeKind, "accepted");
  assert.equal(accepted.status, "continue");
  assert.equal(accepted.countersignStatus, "continue");
  assert.deepEqual(accepted.decisiveFacts, { note: "accepted-facts" });
  assert.deepEqual(accepted.receipt, {
    countersignStatus: "continue",
    fix: { summary: "x" },
  });

  const escalation = projectSecretariatSummonResult({
    exitCode: 0,
    runDirectory: "/r/01b@countersign",
    terminal: {
      roleOutcome: {
        kind: "audit_escalation",
        role: "countersign",
        status: "audit_escalation",
        payloads: [{ countersignStatus: "escalate", decisionGate: { question: "q" } }],
        decisiveFacts: { gate: "open" },
      },
    } as never,
  });
  assert.equal(escalation.outcomeKind, "audit_escalation");
  assert.equal(escalation.status, "audit_escalation");
  assert.equal(escalation.countersignStatus, "escalate");
  assert.deepEqual(escalation.decisiveFacts, { gate: "open" });
  assert.ok(escalation.receipt);

  const failure = projectSecretariatSummonResult({
    exitCode: 1,
    runDirectory: "/r/01c@countersign",
    terminal: {
      roleOutcome: {
        kind: "failure",
        role: "countersign",
        diagnostic: "nested boom",
        cause: "output",
        decisiveFacts: { cause: "output" },
        payloads: [{ partial: true }],
      },
    } as never,
  });
  assert.equal(failure.outcomeKind, "failure");
  assert.equal(failure.diagnostic, "nested boom");
  assert.equal(failure.cause, "output");
  assert.deepEqual(failure.payloads, [{ partial: true }]);
  assert.equal(failure.countersignStatus, undefined);

  const noReceipt = projectSecretariatSummonResult({
    exitCode: 0,
    stderr: "quiet",
    terminal: {
      roleOutcome: {
        kind: "no_receipt",
        role: "countersign",
        status: "no-accepted-receipt",
        decisiveFacts: { acceptedReceipt: false },
      },
    } as never,
  });
  assert.equal(noReceipt.outcomeKind, "no_receipt");
  assert.equal(noReceipt.status, "no-accepted-receipt");
  assert.equal(noReceipt.stderr, "quiet");

  const noTerminal = projectSecretariatSummonResult({
    exitCode: 1,
    stderr: "died",
  });
  assert.equal(noTerminal.outcomeKind, "no_terminal");
  assert.equal(noTerminal.exitCode, 1);
  assert.equal(noTerminal.stderr, "died");
});

test("summon tool content text tracks outcome kind (not always 已送达)", async () => {
  const { tools } = await activateSecretariat({
    summonCountersign: async () => ({
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "countersign",
          diagnostic: "x",
          decisiveFacts: {},
        },
      } as never,
    }),
  });
  const result = await tools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME)!.execute(
    "summon-fail",
    { instruction: "裁：#924" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    (result.content as Array<{ text: string }>)[0]?.text,
    "给事中传召失败",
  );
  assert.equal((result.details as { outcomeKind: string }).outcomeKind, "failure");
});
