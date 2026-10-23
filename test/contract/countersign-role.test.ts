import assert from "node:assert/strict";
import { test } from "vitest";

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
