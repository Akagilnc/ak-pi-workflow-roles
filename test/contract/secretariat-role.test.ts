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

test("#953 summon parent-visible content carries typed facts via readableGateItem, not fixed phrases", async () => {
  const receipt = {
    countersignStatus: "continue",
    findings: [{ article: "a", reason: "r" }],
  };
  const { tools: okTools } = await activateSecretariat({
    summonCountersign: async () => ({
      exitCode: 0,
      runDirectory: "/home/books/x/runs/01child@countersign",
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: "countersign",
          payloads: [receipt],
        },
      } as never,
    }),
  });
  const accepted = await okTools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME)!.execute(
    "summon-ok",
    { instruction: "裁：#953" },
    undefined,
    undefined,
    ctx,
  );
  const acceptedDetails = accepted.details as {
    outcomeKind?: string;
    runId?: string;
    countersignStatus?: string;
    receipt?: { findings?: Array<{ article?: string }> };
  };
  assert.equal(acceptedDetails.outcomeKind, "accepted");
  assert.equal(acceptedDetails.runId, "01child");
  assert.equal(acceptedDetails.countersignStatus, "continue");
  assert.equal(acceptedDetails.receipt?.findings?.[0]?.article, "a");
  const acceptedText = (accepted.content as Array<{ text: string }>)[0]?.text ?? "";
  // Feature observation: facts appear in parent-visible text; no fixed phrases / object collapse.
  // Do not lock JSON serialization shape (compact vs pretty).
  assert.ok(acceptedText.includes("01child"));
  assert.ok(acceptedText.includes("continue"));
  assert.ok(acceptedText.includes("accepted"));
  assert.equal(acceptedText.includes("给事中回执已送达中书省"), false);
  assert.equal(acceptedText.includes("[object Object]"), false);

  const { tools: failTools } = await activateSecretariat({
    summonCountersign: async () => ({
      exitCode: 1,
      runDirectory: "/home/books/x/runs/01fail@countersign",
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "countersign",
          diagnostic: "provider boom",
          decisiveFacts: {},
        },
      } as never,
    }),
  });
  const failed = await failTools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME)!.execute(
    "summon-fail",
    { instruction: "裁：#953" },
    undefined,
    undefined,
    ctx,
  );
  const failedDetails = failed.details as {
    outcomeKind?: string;
    diagnostic?: string;
  };
  assert.equal(failedDetails.outcomeKind, "failure");
  assert.equal(failedDetails.diagnostic, "provider boom");
  const failedText = (failed.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.ok(failedText.includes("provider boom"));
  assert.equal(failedText.includes("给事中传召失败"), false);

  // Failure + historical payloads must still surface diagnostic (bounce on #953).
  const prior = {
    countersignStatus: "continue",
    findings: [{ article: "old", reason: "prior round" }],
  };
  const { tools: histTools } = await activateSecretariat({
    summonCountersign: async () => ({
      exitCode: 1,
      runDirectory: "/home/books/x/runs/01a0a92e@countersign",
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "countersign",
          diagnostic: "WebSocket error",
          cause: "provider",
          decisiveFacts: {},
          payloads: [prior],
        },
      } as never,
    }),
  });
  const histFailed = await histTools
    .get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME)!
    .execute("summon-hist-fail", { instruction: "裁：#953" }, undefined, undefined, ctx);
  const histDetails = histFailed.details as {
    outcomeKind?: string;
    diagnostic?: string;
  };
  assert.equal(histDetails.outcomeKind, "failure");
  assert.equal(histDetails.diagnostic, "WebSocket error");
  const histText = (histFailed.content as Array<{ text: string }>)[0]?.text ?? "";
  // Diagnostic fact must appear in parent-visible text even when historical receipt exists.
  assert.ok(histText.includes("WebSocket error"));
});
