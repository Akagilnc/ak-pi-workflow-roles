import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTARY_OUTPUT_TOOL_NAME,
  validateNotaryOutput,
} from "../../src/notary-contracts.ts";
import { createNotaryRoleRuntime } from "../../src/notary-role.ts";

test("validateNotaryOutput accepts pass bounce incomplete and rejects residual shapes", () => {
  assert.equal(validateNotaryOutput({ status: "pass", findings: [] }).status, "pass");
  const bounce = validateNotaryOutput({ status: "bounce", findings: ["x"] });
  assert.equal(bounce.status, "bounce");
  assert.equal(
    validateNotaryOutput({ status: "incomplete", reason: "missing draft" }).status,
    "incomplete",
  );
  assert.throws(() => validateNotaryOutput({ status: "incomplete", reason: "  " }));
  assert.throws(() => validateNotaryOutput({ status: "maybe" }));
  assert.throws(() => validateNotaryOutput(null));
});

test("Notary runtime registers output tool and injects locator-only materials", async () => {
  const flags = new Map<string, string>();
  const tools = new Map<string, { execute: Function }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const pi = {
    registerFlag(name: string) {
      flags.set(name, "");
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerTool(tool: { name: string; execute: Function }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: { systemPrompt: string }) => unknown) {
      if (event === "before_agent_start") beforeStart = handler;
    },
    getAllTools() {
      return [{ name: NOTARY_OUTPUT_TOOL_NAME }, { name: "bash" }, { name: "read" }];
    },
  };

  const runtime = createNotaryRoleRuntime(
    pi as never,
    {
      loadSoul: async () => "NOTARY LAW",
      loadSourceRunLocator: async (path) => ({
        runDirectory: path,
        runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
        role: "judge",
      }),
    },
    {
      failInfrastructure(error) {
        throw error;
      },
    },
  );

  flags.set("ak-notary-source-run", "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge");
  await runtime.activate();
  assert.ok(tools.has(NOTARY_OUTPUT_TOOL_NAME));
  assert.ok(beforeStart);
  const prompted = beforeStart!({ systemPrompt: "BASE" }) as {
    systemPrompt: string;
  };
  assert.match(prompted.systemPrompt, /NOTARY LAW/);
  assert.match(prompted.systemPrompt, /notary_source_run/);
  assert.match(prompted.systemPrompt, /01a034f1-75bf-71a6-bcf5-d1299145b1a5/);
  // Must not preload draft body — locator only.
  assert.equal(prompted.systemPrompt.includes("judge_draft"), false);
});
