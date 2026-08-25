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

test("Notary runtime registers output tool and binds source-run locator without draft body", async () => {
  const flags = new Map<string, string>();
  const tools = new Map<string, { execute: Function }>();
  let beforeStart: ((event: { systemPrompt: string }) => unknown) | undefined;
  const locator = {
    runDirectory: "/tmp/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
    runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
    role: "judge",
  };
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
      loadSourceRunLocator: async () => locator,
    },
    {
      failInfrastructure(error) {
        throw error;
      },
    },
  );

  flags.set("ak-notary-source-run", locator.runDirectory);
  await runtime.activate();
  assert.ok(tools.has(NOTARY_OUTPUT_TOOL_NAME));
  assert.ok(beforeStart);

  const prompted = beforeStart!({ systemPrompt: "BASE" }) as {
    systemPrompt: string;
  };
  // Locator-only contract: bound identity is present as structured JSON; no draft body preload key.
  assert.equal(prompted.systemPrompt.includes(JSON.stringify({ sourceRun: locator })), true);
  assert.equal(prompted.systemPrompt.includes("judge_draft"), false);
  assert.equal(prompted.systemPrompt.includes('"material"'), false);
});
