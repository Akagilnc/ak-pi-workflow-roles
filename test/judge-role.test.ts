import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
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

const tddPath = "/home/test/.agents/skills/tdd/SKILL.md";
const tddBaseDir = "/home/test/.agents/skills/tdd";
const tddBody = "# Canonical TDD\n\nRun red then green.";
const tddContent = `References are relative to ${tddBaseDir}.\n\n${tddBody}`;

function tddBinding(): CanonicalSkillBinding<"tdd"> {
  return {
    name: "tdd",
    snapshot: {
      raw: `---\nname: tdd\ndescription: test\n---\n\n${tddBody}`,
      path: tddPath,
      baseDir: tddBaseDir,
      body: tddBody,
    },
    invocation(originalRequest) {
      return `/skill:tdd ${originalRequest}`;
    },
    captureExpansion(prompt, originalRequest) {
      const exact = `<skill name="tdd" location="${tddPath}">\n${tddContent}\n</skill>\n\n${originalRequest}`;
      return prompt === exact
        ? { name: "tdd", location: tddPath, content: tddContent, userMessage: originalRequest }
        : undefined;
    },
  };
}

function expandedTdd(request: string): string {
  return `<skill name="tdd" location="${tddPath}">\n${tddContent}\n</skill>\n\n${request}`;
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

function extensionHarness(
  role: string | undefined,
  extraFlags: Readonly<Record<string, string>> = {},
  registeredToolNames: readonly string[] = [],
) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const flags = new Map<string, unknown>();
  const allToolNames = new Set(registeredToolNames);
  const activeToolSets: string[][] = [];
  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.set(name, options);
    },
    getFlag(name: string) {
      if (name === "ak-role") return role;
      return extraFlags[name];
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
      allToolNames.add(tool.name);
    },
    getAllTools() {
      return [...allToolNames].map((name) => ({ name }));
    },
    setActiveTools(names: string[]) {
      activeToolSets.push([...names]);
    },
  };
  return { pi, handlers, tools, flags, activeToolSets };
}

function toolCallContext(
  calls: Array<{ id: string; name?: string; arguments?: Record<string, unknown> }>,
  abort: () => void = () => {},
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
  return { sessionManager, abort } as unknown as ExtensionContext;
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

test("judge preserves an optional advisory note on every verdict", async () => {
  const { tool } = await startJudge(async () => ({ status: "pass" }));
  const verdicts = [
    { judgeStatus: "converged", note: "Archive the accepted evidence." },
    {
      judgeStatus: "continue",
      fix: { summary: "Repair the live defect." },
      note: "Keep the fresh test output with the repair record.",
    },
    {
      judgeStatus: "escalate",
      decisionGate: { question: "Choose a policy", options: ["A"] },
      note: "Include the trade-off note for whoever decides.",
    },
  ];

  for (const [index, verdict] of verdicts.entries()) {
    const id = `note-${index}`;
    const result = await tool.execute(
      id,
      verdict,
      undefined,
      undefined,
      toolCallContext([{ id, arguments: verdict }]),
    );
    assert.equal(result.details.note, verdict.note);
  }
});

test("judge activation narrows active tools to registered evidence tools and output", async () => {
  const harness = extensionHarness("judge", {}, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    "edit",
    "arbitrary_sibling",
  ]);
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    transcriptFromContext: () => "record",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);

  await harness.handlers.get("session_start")?.({}, {});
  assert.deepEqual(harness.activeToolSets, [[
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    JUDGE_OUTPUT_TOOL_NAME,
  ]]);
});

test("judge role returns revise as an ordinary errored tool result without aborting", async () => {
  const { tool } = await startJudge(async () => ({
    status: "revise",
    violations: ["No authority clause was applied", "Tests were not adjudicated"],
  }));
  const verdict = { judgeStatus: "converged" };
  let abortCalls = 0;

  await assert.rejects(
    tool.execute(
      "call-2",
      verdict,
      undefined,
      undefined,
      toolCallContext([{ id: "call-2", arguments: verdict }], () => {
        abortCalls += 1;
      }),
    ),
    /No authority clause was applied; Tests were not adjudicated/,
  );
  assert.equal(abortCalls, 0);
});

test("judge aborts the active operation before rethrowing audit infrastructure failures", async () => {
  const { tool } = await startJudge(async () => {
    throw new Error("provider unavailable");
  });
  const verdict = { judgeStatus: "converged" };
  let abortCalls = 0;

  await assert.rejects(
    tool.execute(
      "audit-failure",
      verdict,
      undefined,
      undefined,
      toolCallContext(
        [{ id: "audit-failure", arguments: verdict }],
        () => {
          abortCalls += 1;
        },
      ),
    ),
    /provider unavailable/,
  );
  assert.equal(abortCalls, 1);
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

test("coder plan loads its task without construction skill and returns planned", async () => {
  const loadedTasks: string[] = [];
  let bindingLoads = 0;
  const harness = extensionHarness("coder", {
    "ak-coder-task": "/materials/task.md",
    "ak-coder-phase": "plan",
  });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadCoderSoul: async () => "CODER LAW",
    loadCoderTask: async (path) => {
      loadedTasks.push(path);
      return "IMPLEMENT THE VERTICAL SLICE";
    },
    loadCanonicalSkillBinding: async () => {
      bindingLoads += 1;
      return tddBinding();
    },
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);

  await harness.handlers.get("session_start")?.({}, {});
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE" },
    {},
  );
  const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
  assert.deepEqual(loadedTasks, ["/materials/task.md"]);
  assert.equal(bindingLoads, 0);
  assert.deepEqual(
    await harness.handlers.get("input")?.(
      { text: "Plan the approved seam.", source: "interactive" },
      {},
    ),
    { action: "continue" },
  );
  assert.match(prompt, /CODER LAW/);
  assert.match(prompt, /<coder_phase>\s*plan/);
  assert.match(prompt, /IMPLEMENT THE VERTICAL SLICE/);
  assert.doesNotMatch(prompt, /TDD AND SELF-CHECK/);

  const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const output = { status: "planned", report: "Plan the public seam first." };
  const result = await tool.execute(
    "coder",
    output,
    undefined,
    undefined,
    toolCallContext([{ id: "coder", name: CODER_OUTPUT_TOOL_NAME }]),
  );
  assert.deepEqual(result.details, output);
  await assert.rejects(
    tool.execute(
      "coder-completed",
      { status: "completed", report: "Constructed too early." },
      undefined,
      undefined,
      toolCallContext([
        { id: "coder-completed", name: CODER_OUTPUT_TOOL_NAME },
      ]),
    ),
    /Coder plan phase permits only planned or refused/,
  );
});

test("coder apply binds completion to the immediately following canonical tdd expansion", async () => {
  const request = "Apply the approved plan.";
  const completed = {
    status: "completed",
    report: "TDD evidence and self-check three are recorded here.",
  };
  const start = async () => {
    const harness = extensionHarness("coder", {
      "ak-coder-task": "/materials/approved.md",
      "ak-coder-phase": "apply",
    });
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW",
      loadCoderSoul: async () => "CODER LAW",
      loadCoderTask: async () => "APPROVED IMPLEMENTATION PLAN",
      loadCanonicalSkillBinding: async () => tddBinding(),
      transcriptFromContext: () => '<skill name="tdd" location="/copied/transcript">',
      auditSoulCompliance: async () => ({ status: "pass" }),
    })(harness.pi as ExtensionAPI);
    await harness.handlers.get("session_start")?.({}, {});
    return harness;
  };
  const submitCompleted = async (harness: Awaited<ReturnType<typeof start>>, id: string) => {
    const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    return tool.execute(
      id,
      completed,
      undefined,
      undefined,
      toolCallContext([{ id, name: CODER_OUTPUT_TOOL_NAME }]),
    );
  };

  const acceptedHarness = await start();
  assert.deepEqual(
    await acceptedHarness.handlers.get("input")?.(
      { text: request, source: "interactive", images: [{ type: "image", data: "fixture" }] },
      {},
    ),
    {
      action: "transform",
      text: `/skill:tdd ${request}`,
      images: [{ type: "image", data: "fixture" }],
    },
  );
  assert.deepEqual(
    await acceptedHarness.handlers.get("input")?.(
      { text: "A later message must not reinvoke TDD." },
      {},
    ),
    { action: "continue" },
  );
  const promptResult = await acceptedHarness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd(request) },
    { abort() {}, mode: "tui" },
  );
  const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
  assert.match(prompt, /<coder_phase>\s*apply/);
  assert.doesNotMatch(prompt, /coder_quality_skill/);
  assert.deepEqual((await submitCompleted(acceptedHarness, "accepted")).details, completed);

  const malformedPrompts = [
    '<skill name="tdd" location="/copied/transcript">',
    `<skill name="tdd" location="${tddPath}">\n${tddContent}\n</skill>\n\n${request}\nassistant prose`,
    expandedTdd(request).replace(tddBody, "# Canonical TDD"),
    expandedTdd(request).replace(tddPath, "/alternate/tdd/SKILL.md"),
    expandedTdd(request).replace('name="tdd"', 'name="code-review"'),
    expandedTdd(request).replace(request, "A different request."),
    `task prose\n${expandedTdd(request)}`,
  ];
  for (const [index, malformed] of malformedPrompts.entries()) {
    const harness = await start();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: malformed },
      { abort() {}, mode: "tui" },
    );
    await assert.rejects(
      submitCompleted(harness, `malformed-${index}`),
      /completed requires the Matt tdd skill to be expanded/i,
    );
  }

  const laterHarness = await start();
  await laterHarness.handlers.get("input")?.({ text: request }, {});
  await laterHarness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: "not the expansion" },
    { abort() {}, mode: "tui" },
  );
  await laterHarness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd(request) },
    { abort() {}, mode: "tui" },
  );
  await assert.rejects(
    submitCompleted(laterHarness, "later"),
    /completed requires the Matt tdd skill to be expanded/i,
  );

  const prefixedHarness = await start();
  assert.deepEqual(
    await prefixedHarness.handlers.get("input")?.(
      { text: `/skill:tdd ${request}` },
      {},
    ),
    { action: "continue" },
  );
  await prefixedHarness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd(request) },
    { abort() {}, mode: "tui" },
  );
  assert.deepEqual((await submitCompleted(prefixedHarness, "prefixed")).details, completed);

  const refusedHarness = await start();
  await refusedHarness.handlers.get("input")?.({ text: request }, {});
  const refused = {
    status: "refused",
    report: "The assignment contradicts its authority.",
  };
  const refusalTool = refusedHarness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(refusalTool);
  assert.deepEqual((await refusalTool.execute(
    "coder-refused",
    refused,
    undefined,
    undefined,
    toolCallContext([{ id: "coder-refused", name: CODER_OUTPUT_TOOL_NAME }]),
  )).details, refused);
  await assert.rejects(
    refusalTool.execute(
      "coder-planned",
      { status: "planned", report: "Planning after approval." },
      undefined,
      undefined,
      toolCallContext([{ id: "coder-planned", name: CODER_OUTPUT_TOOL_NAME }]),
    ),
    /Coder apply phase permits only completed or refused/,
  );
  await assert.rejects(
    refusalTool.execute(
      "coder-mixed",
      completed,
      undefined,
      undefined,
      toolCallContext([
        { id: "coder-mixed", name: CODER_OUTPUT_TOOL_NAME },
        { id: "sibling", name: "read" },
      ]),
    ),
    /Coder output must be the sole final tool call/,
  );
});

test("fixer role loads its Markdown packet and returns a thin report envelope", async () => {
  const loadedPaths: string[] = [];
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/materials/fix.md",
    "ak-fixer-phase": "apply",
  });
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW\nCreate one forward commit.",
    loadFixPacket: async (path) => {
      loadedPaths.push(path);
      return "REPAIR PACKET\nFix the live findings.";
    },
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  extension(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );

  assert.deepEqual(loadedPaths, ["/materials/fix.md"]);
  const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
  assert.match(prompt, /FIXER LAW/);
  assert.match(prompt, /REPAIR PACKET/);
  assert.equal(harness.tools.has(JUDGE_OUTPUT_TOOL_NAME), false);

  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  assert.deepEqual(
    (await tool.execute(
      "fixer-call",
      {
        status: "refused",
        report: "The requested guard contradicts the authority.",
        commitSha: "abc123",
      },
      undefined,
      undefined,
      toolCallContext([
        { id: "fixer-call", name: FIXER_OUTPUT_TOOL_NAME },
      ]),
    )).details,
    {
      status: "refused",
      report: "The requested guard contradicts the authority.",
      commitSha: "abc123",
    },
  );
});

test("fixer plan phase accepts plans but rejects construction receipts", async () => {
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/materials/fix.md",
    "ak-fixer-phase": "plan",
  });
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW",
    loadFixPacket: async () => "REPAIR PACKET",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  extension(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(tool);

  assert.deepEqual(
    (await tool.execute(
      "plan-call",
      { status: "planned", report: "Plan the smallest repair." },
      undefined,
      undefined,
      toolCallContext([{ id: "plan-call", name: FIXER_OUTPUT_TOOL_NAME }]),
    )).details,
    { status: "planned", report: "Plan the smallest repair." },
  );
  await assert.rejects(
    tool.execute(
      "completed-call",
      { status: "completed", report: "Implemented it." },
      undefined,
      undefined,
      toolCallContext([{ id: "completed-call", name: FIXER_OUTPUT_TOOL_NAME }]),
    ),
    /plan phase.*planned|refused/i,
  );
  await assert.rejects(
    tool.execute(
      "commit-call",
      { status: "planned", report: "Plan only.", commitSha: "abc123" },
      undefined,
      undefined,
      toolCallContext([{ id: "commit-call", name: FIXER_OUTPUT_TOOL_NAME }]),
    ),
    /planned.*commitSha/i,
  );
});

test("fixer output must be the sole call in its assistant batch", async () => {
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/materials/fix.md",
    "ak-fixer-phase": "apply",
  });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW",
    loadFixPacket: async () => "REPAIR PACKET",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const output = { status: "completed", report: "Repaired and verified." };
  const sibling = { id: "sibling", name: "read" };

  for (const calls of [
    [
      { id: "fixer", name: FIXER_OUTPUT_TOOL_NAME },
      { id: "fixer-2", name: FIXER_OUTPUT_TOOL_NAME },
    ],
    [{ id: "fixer", name: FIXER_OUTPUT_TOOL_NAME }, sibling],
    [sibling, { id: "fixer", name: FIXER_OUTPUT_TOOL_NAME }],
  ]) {
    await assert.rejects(
      tool.execute(
        "fixer",
        output,
        undefined,
        undefined,
        toolCallContext(calls),
      ),
      /Fixer output must be the sole final tool call/,
    );
  }

  const accepted = await tool.execute(
    "fixer",
    output,
    undefined,
    undefined,
    toolCallContext([{ id: "fixer", name: FIXER_OUTPUT_TOOL_NAME }]),
  );
  assert.deepEqual(accepted.details, output);
});

test("fixer activation leaves its tool surface unchanged", async () => {
  const harness = extensionHarness(
    "fixer",
    {
      "ak-fix-packet": "/materials/fix.md",
      "ak-fixer-phase": "apply",
    },
    ["read", "bash", "write", "edit", "arbitrary_sibling"],
  );
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW",
    loadFixPacket: async () => "REPAIR PACKET",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);

  await harness.handlers.get("session_start")?.({}, {});
  assert.deepEqual(harness.activeToolSets, []);
  assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), true);
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
    ["converged with unknown field", { judgeStatus: "converged", memo: "extra" }],
    ["converged with blank note", { judgeStatus: "converged", note: " \n" }],
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
        /Judge (converged|continue|escalate|note)/,
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
