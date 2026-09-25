/**
 * #632 / #753 — countersign → Notary gate queue.
 * Pointer-only summons; parent status read for queue only; raw receipt back on bounce.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
};

async function activateCountersign(): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const roleHost = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on() {},
    getAllTools() {
      return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }];
    },
    getFlag() {
      return undefined;
    },
  };
  await createCountersignRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "LAW" },
  ).activate();
  return { tools };
}

const ctx = {
  cwd: "/tmp",
  mode: "json",
  model: undefined,
  sessionManager: {} as never,
  abort() {},
};

test("countersign output finishes before Notary is summoned", async () => {
  const { tools } = await activateCountersign();
  const result = await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
    "call-1",
    { status: "converged" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { status: "converged" });
});

test("countersign escalate skips Notary gate and accepts as-is (#753)", async () => {
  const { tools } = await activateCountersign();
  const result = await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
    "call-esc",
    { status: "escalate", note: "need owner" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { status: "escalate", note: "need owner" });
});

test("countersign unreadable status files before public queue reask (#1057)", async () => {
  const { tools } = await activateCountersign();
  const result = await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
      "call-bad",
      { status: "not-a-status", note: "typo" },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { status: "not-a-status", note: "typo" });
});
