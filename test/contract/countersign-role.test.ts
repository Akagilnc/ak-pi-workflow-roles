import assert from "node:assert/strict";
import test from "node:test";

import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { createCountersignRoleRuntime } from "../../src/role-runtime.ts";

/** Host tool boundary for the Countersign runtime. */
function countersignHarness() {
  const tools = new Map<string, { name: string; execute: Function; parameters?: unknown }>();
  const roleHost = {
    registerTool(tool: { name: string; execute: Function; parameters?: unknown }) { tools.set(tool.name, tool); },
    on() {},
    getAllTools() { return [{ name: COUNTERSIGN_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }]; },
  };
  return { tools, roleHost };
}

test("Countersign runtime refuses empty soul", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.roleHost as never,
    { loadSoul: async () => "   " },
  );
  await assert.rejects(runtime.activate());
});

test("Countersign execute accepts as-is and terminates — sole-final barrier is ledger-owned", async () => {
  const h = countersignHarness();
  const runtime = createCountersignRoleRuntime(
    h.roleHost as never,
    { loadSoul: async () => "LAW" },
  );
  await runtime.activate();
  const tool = h.tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME);
  assert.ok(tool);

  const withFindings = await tool.execute(
    "one",
    { status: "continue", findings: ["x"] },
    undefined,
    undefined,
    {},
  );
  assert.equal(withFindings.terminate, true);
  assert.equal(
    (withFindings.details as { status: string }).status,
    "continue",
  );
  assert.deepEqual(withFindings.content, []);

  const withoutClauses = await tool.execute(
    "no-clauses",
    { status: "converged" },
    undefined,
    undefined,
    {},
  );
  assert.equal(withoutClauses.terminate, true);
  assert.deepEqual(withoutClauses.details, { status: "converged" });

  const legacy = {
    status: "converged",
    clauses: [{ clause: "c", ownerUuid: null, derivation: "d" }],
  };
  const withLegacyClauses = await tool.execute("legacy", legacy, undefined, undefined, {});
  assert.equal(withLegacyClauses.terminate, true);
  assert.deepEqual(withLegacyClauses.details, legacy);
});
