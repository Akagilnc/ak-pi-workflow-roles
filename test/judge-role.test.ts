import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  JUDGE_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type SoulAuditInput,
} from "../src/role-runtime.ts";

type Handler = (event: any, ctx: any) => unknown;
type Tool = {
  name: string;
  execute: (...args: any[]) => Promise<any>;
};

function extensionHarness(role: string | undefined) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const flags = new Map<string, unknown>();
  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.set(name, options);
    },
    getFlag(name: string) {
      return name === "ak-role" ? role : undefined;
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
  };
  return { pi, handlers, tools, flags };
}

test("judge role injects its soul and accepts a soul-compliant fixed verdict", async () => {
  const seenAudits: SoulAuditInput[] = [];
  const harness = extensionHarness("judge");
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
    transcriptFromContext: () => "review evidence and adjudication",
    auditSoulCompliance: async (input) => {
      seenAudits.push(input);
      return { status: "pass" };
    },
  });

  extension(harness.pi as ExtensionAPI);
  assert.ok(harness.flags.has("ak-role"));

  await harness.handlers.get("session_start")?.({}, {});
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );
  assert.match((promptResult as { systemPrompt: string }).systemPrompt, /JUDGE LAW/);

  const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const verdict = { judgeStatus: "converged" };
  const result = await tool.execute("call-1", verdict, undefined, undefined, {});

  assert.deepEqual(seenAudits, [
    {
      soul: "JUDGE LAW\nApply the law.",
      transcript: "review evidence and adjudication",
      verdict,
    },
  ]);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, verdict);
});

test("judge role rejects a verdict when the soul audit requires revision", async () => {
  const harness = extensionHarness("judge");
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    transcriptFromContext: () => "adjudication transcript",
    auditSoulCompliance: async () => ({
      status: "revise",
      violations: ["No authority clause was applied", "Test quality was not adjudicated"],
    }),
  });

  extension(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
  assert.ok(tool);

  await assert.rejects(
    tool.execute("call-2", { judgeStatus: "converged" }, undefined, undefined, {}),
    /No authority clause was applied; Test quality was not adjudicated/,
  );
});

test("judge role fails before adjudication when its soul is empty", async () => {
  const harness = extensionHarness("judge");
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "   \n",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  extension(harness.pi as ExtensionAPI);

  await assert.rejects(
    Promise.resolve(harness.handlers.get("session_start")?.({}, {})),
    /Judge soul is empty/,
  );
  assert.equal(harness.tools.has(JUDGE_OUTPUT_TOOL_NAME), false);
});

test("fixer role injects its own soul without exposing judge output", async () => {
  const harness = extensionHarness("fixer");
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW\nCreate one forward commit.",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  extension(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );

  assert.match((promptResult as { systemPrompt: string }).systemPrompt, /FIXER LAW/);
  assert.equal(harness.tools.has(JUDGE_OUTPUT_TOOL_NAME), false);
});

test("judge role rejects incomplete status-specific verdicts before soul audit", async () => {
  let auditCalls = 0;
  const harness = extensionHarness("judge");
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    transcriptFromContext: () => "adjudication transcript",
    auditSoulCompliance: async () => {
      auditCalls += 1;
      return { status: "pass" };
    },
  });

  extension(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
  assert.ok(tool);

  await assert.rejects(
    tool.execute("call-3", { judgeStatus: "continue" }, undefined, undefined, {}),
    /continue requires fix.summary/,
  );
  await assert.rejects(
    tool.execute("call-4", { judgeStatus: "escalate" }, undefined, undefined, {}),
    /escalate requires decisionGate/,
  );
  assert.equal(auditCalls, 0);
});
