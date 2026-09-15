/**
 * #924 Secretariat (中书省) — envelope-assembled tools + nested countersign summon.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
} from "../../src/secretariat-contracts.ts";
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
    countersignStatus?: string;
    runId?: string;
  };
  assert.equal(details.countersignStatus, "converged");
  assert.equal(details.runId, "01child");
});
