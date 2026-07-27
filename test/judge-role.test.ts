import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  JUDGE_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type JudgeVerdict,
  type SoulAuditInput,
} from "../src/role-runtime.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
  name: string;
  execute: (...args: any[]) => Promise<any>;
};

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

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

function toolCallContext(
  calls: Array<{ id: string; name?: string; arguments?: Record<string, unknown> }>,
): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name ?? JUDGE_OUTPUT_TOOL_NAME,
      arguments: call.arguments ?? {},
    })),
    api: "openai-responses",
    provider: "test",
    model: "judge",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  sessionManager.appendMessage(message);
  return { sessionManager } as unknown as ExtensionContext;
}

async function startJudge(
  auditSoulCompliance: Parameters<
    typeof createRoleRuntimeExtension
  >[0]["auditSoulCompliance"],
) {
  const harness = extensionHarness("judge");
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
    transcriptFromContext: () => "review evidence and adjudication",
    auditSoulCompliance,
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  return { harness, tool };
}

test("judge role injects its soul and accepts a soul-compliant verdict", async () => {
  const seenAudits: SoulAuditInput[] = [];
  const { harness, tool } = await startJudge(async (input) => {
    seenAudits.push(input);
    return { status: "pass" };
  });

  assert.ok(harness.flags.has("ak-role"));
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );
  assert.match((promptResult as { systemPrompt: string }).systemPrompt, /JUDGE LAW/);

  const verdict: JudgeVerdict = { judgeStatus: "converged" };
  const result = await tool.execute(
    "call-1",
    verdict,
    undefined,
    undefined,
    toolCallContext([{ id: "call-1", arguments: verdict }]),
  );

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

test("judge role accepts valid examples of all three verdict shapes", async () => {
  const audited: JudgeVerdict[] = [];
  const { tool } = await startJudge(async ({ verdict }) => {
    audited.push(verdict);
    return { status: "pass" };
  });
  const verdicts: JudgeVerdict[] = [
    { judgeStatus: "converged" },
    { judgeStatus: "continue", fix: { summary: "Repair the parser" } },
    {
      judgeStatus: "escalate",
      decisionGate: { question: "Which API?", options: ["A", "B"] },
    },
  ];

  for (const [index, verdict] of verdicts.entries()) {
    const id = `valid-${index}`;
    const result = await tool.execute(
      id,
      verdict,
      undefined,
      undefined,
      toolCallContext([{ id, arguments: verdict }]),
    );
    assert.deepEqual(result.details, verdict);
  }
  assert.deepEqual(audited, verdicts);
});

test("judge role rejects a verdict when the soul audit requires revision", async () => {
  const { tool } = await startJudge(async () => ({
    status: "revise",
    violations: ["No authority clause was applied", "Tests were not adjudicated"],
  }));
  const verdict = { judgeStatus: "converged" };

  await assert.rejects(
    tool.execute(
      "call-2",
      verdict,
      undefined,
      undefined,
      toolCallContext([{ id: "call-2", arguments: verdict }]),
    ),
    /No authority clause was applied; Tests were not adjudicated/,
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

test("judge role rejects mixed and blank verdict shapes before soul audit", async (t) => {
  let auditCalls = 0;
  const { tool } = await startJudge(async () => {
    auditCalls += 1;
    return { status: "pass" };
  });
  const gate = { question: "Choose", options: ["A"] };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["converged with fix", { judgeStatus: "converged", fix: { summary: "x" } }],
    ["converged with gate", { judgeStatus: "converged", decisionGate: gate }],
    ["converged with unknown field", { judgeStatus: "converged", note: "extra" }],
    ["continue without fix", { judgeStatus: "continue" }],
    ["continue with blank summary", { judgeStatus: "continue", fix: { summary: " \n" } }],
    ["continue with extra fix field", { judgeStatus: "continue", fix: { summary: "x", note: "extra" } }],
    ["continue with gate", { judgeStatus: "continue", fix: { summary: "x" }, decisionGate: gate }],
    ["escalate without gate", { judgeStatus: "escalate" }],
    ["escalate with blank question", { judgeStatus: "escalate", decisionGate: { question: "  ", options: ["A"] } }],
    ["escalate with no options", { judgeStatus: "escalate", decisionGate: { question: "Choose", options: [] } }],
    ["escalate with blank option", { judgeStatus: "escalate", decisionGate: { question: "Choose", options: ["A", " "] } }],
    ["escalate with fix", { judgeStatus: "escalate", decisionGate: gate, fix: { summary: "x" } }],
  ];

  for (const [index, [name, verdict]] of cases.entries()) {
    await t.test(name, async () => {
      const id = `invalid-${index}`;
      await assert.rejects(
        tool.execute(
          id,
          verdict,
          undefined,
          undefined,
          toolCallContext([{ id, arguments: verdict }]),
        ),
        /Judge (converged|continue|escalate)/,
      );
    });
  }
  assert.equal(auditCalls, 0);
});

test("judge output must be the sole call in its assistant batch", async () => {
  let auditCalls = 0;
  const { tool } = await startJudge(async () => {
    auditCalls += 1;
    return { status: "pass" };
  });
  const verdict = { judgeStatus: "converged" };
  const sibling = { id: "sibling", name: "read", arguments: { path: "README.md" } };

  for (const calls of [
    [{ id: "judge", arguments: verdict }, sibling],
    [sibling, { id: "judge", arguments: verdict }],
  ]) {
    await assert.rejects(
      tool.execute(
        "judge",
        verdict,
        undefined,
        undefined,
        toolCallContext(calls),
      ),
      /sole final tool call/,
    );
  }
  assert.equal(auditCalls, 0);
});
