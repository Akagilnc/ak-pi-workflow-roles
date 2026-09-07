/**
 * #632 / #753 — countersign → Notary gate queue.
 * Pointer-only summons; parent status read for queue only; raw receipt back on bounce.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";
import { ParentQueueReaskError } from "../../src/submission-errors.ts";

type GateCall = { readonly kind: string; readonly subject: unknown };

type HostHarness = {
  readonly tools: Map<string, { name: string; execute: Function }>;
  readonly gateCalls: GateCall[];
  readonly nonPass: unknown[];
};

async function activateCountersign(): Promise<HostHarness> {
  const tools = new Map<string, { name: string; execute: Function }>();
  const gateCalls: GateCall[] = [];
  const nonPass: unknown[] = [];
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
    async requireGatekeeperPass(options: {
      subject: { kind: string };
    }) {
      gateCalls.push({
        kind: options.subject.kind,
        subject: options.subject,
      });
    },
  };
  await createCountersignRoleRuntime(
    roleHost as never,
    { loadSoul: async () => "LAW" },
    {
      failInfrastructure(): never {
        throw new Error("fail");
      },
      bindSubmissionNonPass(_id, result) {
        nonPass.push(result);
      },
    },
  ).activate();
  return { tools, gateCalls, nonPass };
}

const ctx = {
  cwd: "/tmp",
  mode: "json",
  model: undefined,
  sessionManager: {} as never,
  abort() {},
};

test("countersign gate summons Notary with kind only — no verdict/ticket body", async () => {
  const { tools, gateCalls } = await activateCountersign();
  await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
    "call-1",
    { countersignStatus: "converged" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0]!.kind, "countersign_verdict");
  assert.deepEqual(gateCalls[0]!.subject, { kind: "countersign_verdict" });
  assert.equal(
    Object.prototype.hasOwnProperty.call(gateCalls[0]!.subject as object, "material"),
    false,
  );
});

test("countersign escalate skips Notary gate and accepts as-is (#753)", async () => {
  const { tools, gateCalls } = await activateCountersign();
  const result = await tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
    "call-esc",
    { countersignStatus: "escalate", note: "need owner" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(gateCalls.length, 0, "escalate must not summon notary");
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { countersignStatus: "escalate", note: "need owner" });
});

test("countersign status unreadable returns to countersign without Notary (#753)", async () => {
  const { tools, gateCalls, nonPass } = await activateCountersign();
  await assert.rejects(
    tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME)!.execute(
      "call-bad",
      { countersignStatus: "not-a-status", note: "typo" },
      undefined,
      undefined,
      ctx,
    ),
    (error: unknown) => {
      // Parent re-ask — not a forged officer bounce face (#753).
      assert.ok(error instanceof ParentQueueReaskError);
      assert.match(error.message, /countersignStatus/);
      return true;
    },
  );
  assert.equal(gateCalls.length, 0, "bad status must not summon notary");
  assert.equal(nonPass.length, 0, "parent re-ask must not bind officer non-pass");
});
