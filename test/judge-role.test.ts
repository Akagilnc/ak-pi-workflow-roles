import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Context, type Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../src/fixer-auditor.ts";
import { createJudgeRoleRuntime } from "../src/judge-role.ts";
import { reviewerPromptIdentity } from "../src/reviewer-prompt-identity.ts";
import {
  createCoderRoleRuntime,
  createFixerRoleRuntime,
} from "../src/worker-role.ts";
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
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: any;
  execute: (...args: any[]) => Promise<any>;
};

const emptyFixPacket = JSON.stringify({ version: 1, instructions: "Repair the assigned findings.", prerequisites: [] });
const declaredFixPacket = JSON.stringify({ version: 1, instructions: "Repair the assigned findings.", prerequisites: [{ id: "owner.choice", requirement: "Owner selects the contract." }] });

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
      snapshotIdentity: reviewerPromptIdentity(`---\nname: tdd\ndescription: test\n---\n\n${tddBody}`),
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

test("stable factory registers all role flags in exact help order and stays inert without a role", async () => {
  let loads = 0;
  const harness = extensionHarness(undefined);
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => { loads += 1; return "judge"; },
    loadFixerSoul: async () => { loads += 1; return "fixer"; },
    loadCoderSoul: async () => { loads += 1; return "coder"; },
    loadReviewerSoul: async () => { loads += 1; return "reviewer"; },
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);

  assert.deepEqual([...harness.flags], [
    ["ak-role", {
      description: "Activate a packaged workflow role: judge, fixer, coder, reviewer, collector, or doctor",
      type: "string",
    }],
    ["ak-fix-packet", {
      description: "Path to a closed FixPacketV1 JSON repair packet",
      type: "string",
    }],
    ["ak-fixer-phase", {
      description: "Fixer phase: plan (inspect and propose a repair plan; no edits or commits) or apply (execute the approved plan, verify, and commit when repaired)",
      type: "string",
    }],
    ["ak-coder-task", {
      description: "Markdown task assigned to the coder role",
      type: "string",
    }],
    ["ak-coder-phase", {
      description: "Coder phase: plan (inspect and propose an implementation plan; no edits or commits) or apply (execute the approved plan and verify the first implementation)",
      type: "string",
    }],
    ["ak-review-task", {
      description: "Opaque Markdown review task assigned to the reviewer role",
      type: "string",
    }],
    ["ak-review-capabilities", {
      description: "Closed Reviewer capability grant bound to the exact task bytes",
      type: "string",
    }],
    ["ak-review-scope-keys", {
      description: "Optional comma-separated exact class keys limiting Reviewer scope",
      type: "string",
    }],
    ["ak-doctor-evidence", {
      description: "Path to a frozen Doctor v1 evidence index JSON file",
      type: "string",
    }],
    ["ak-collector-repo", {
      description:
        "GitHub owner/repo target for Collector (github.com only; conservative ASCII grammar). Collector forbids every Skill, including command-only Skills.",
      type: "string",
    }],
    ["ak-collector-pr", {
      description:
        "Positive safe-integer pull request number for Collector. Supported profile: --no-skills, --no-extensions with only the explicit Collector package extension, no prompt templates/context files, one print/JSON prompt",
      type: "string",
    }],
    ["ak-collector-legs", {
      description:
        "Path to the Collector v1 leg manifest JSON file. Pi 0.82.1 late hostile sibling-extension Skill injection is unsupported and fail-closed when detected; drift prevention only, not a security boundary or provider-zero guarantee",
      type: "string",
    }],
  ]);
  assert.deepEqual([...harness.handlers.keys()], ["session_start"]);
  await harness.handlers.get("session_start")?.({}, {});
  assert.equal(loads, 0);
  assert.deepEqual([...harness.tools], []);
  assert.deepEqual(harness.activeToolSets, []);
  for (const event of [
    "input", "before_agent_start", "tool_execution_start", "tool_execution_end",
    "tool_call", "tool_result", "session_shutdown",
  ]) assert.equal(harness.handlers.has(event), false, event);
});

test("unsupported role fails with the frozen diagnostic before any loader runs", async () => {
  let loads = 0;
  const harness = extensionHarness("router");
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => { loads += 1; return "judge"; },
    loadFixerSoul: async () => { loads += 1; return "fixer"; },
    loadCoderSoul: async () => { loads += 1; return "coder"; },
    loadReviewerSoul: async () => { loads += 1; return "reviewer"; },
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);

  await assert.rejects(
    Promise.resolve(harness.handlers.get("session_start")?.({}, {})),
    new Error("Unsupported workflow role: router"),
  );
  assert.equal(loads, 0);
  assert.deepEqual([...harness.tools], []);
});

test("focused Judge controller owns activation, output, narrowing, and prompt", async () => {
  const harness = extensionHarness(undefined, {}, ["read", "bash", "write"]);
  const runtime = createJudgeRoleRuntime(
    harness.pi as ExtensionAPI,
    {
      loadSoul: async () => "  JUDGE LAW  ",
      transcriptFromContext: () => "record",
      auditSoulCompliance: async () => ({ status: "pass" }),
    },
    { failInfrastructure(error) { throw error; } },
  );

  await runtime.activate();

  assert.deepEqual([...harness.tools.keys()], [JUDGE_OUTPUT_TOOL_NAME]);
  assert.deepEqual(harness.activeToolSets, [["read", "bash", JUDGE_OUTPUT_TOOL_NAME]]);
  assert.equal(
    (await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {},
    ) as { systemPrompt: string }).systemPrompt,
    "BASE\n\n<judge_soul>\nJUDGE LAW\n</judge_soul>",
  );
});

test("focused Fixer and Coder controllers own their flags and distinct lifecycle hooks", async () => {
  const fixer = extensionHarness(undefined, {
    "ak-fix-packet": "/packet.md",
    "ak-fixer-phase": "plan",
  });
  const fixerRuntime = createFixerRoleRuntime(
    fixer.pi as ExtensionAPI,
    {
      loadSoul: async () => "FIXER LAW",
      loadPacket: async () => emptyFixPacket,
    },
  );
  assert.deepEqual([...fixer.flags.keys()], ["ak-fix-packet", "ak-fixer-phase"]);
  await fixerRuntime.activate();
  assert.deepEqual([...fixer.tools.keys()], [FIXER_OUTPUT_TOOL_NAME]);
  assert.ok(fixer.handlers.has("before_agent_start"));
  assert.equal(fixer.handlers.has("input"), false);

  const coder = extensionHarness(undefined, {
    "ak-coder-task": "/task.md",
    "ak-coder-phase": "plan",
  });
  const coderRuntime = createCoderRoleRuntime(
    coder.pi as ExtensionAPI,
    {
      loadSoul: async () => "CODER LAW",
      loadTask: async () => "TASK",
    },
    { failInfrastructure(error) { throw error; } },
  );
  assert.deepEqual([...coder.flags.keys()], ["ak-coder-task", "ak-coder-phase"]);
  await coderRuntime.activate();
  assert.deepEqual([...coder.tools.keys()], [CODER_OUTPUT_TOOL_NAME]);
  assert.ok(coder.handlers.has("before_agent_start"));
  assert.ok(coder.handlers.has("input"));
});

test("stable factory preserves exact Judge, Fixer, and Coder prompt bytes", async () => {
  const cases = [
    {
      role: "judge",
      flags: {},
      dependencies: { loadJudgeSoul: async () => "  JUDGE LAW\n  " },
      expected: "BASE\n\n<judge_soul>\nJUDGE LAW\n</judge_soul>",
    },
    {
      role: "fixer",
      flags: { "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" },
      dependencies: {
        loadJudgeSoul: async () => "judge",
        loadFixerSoul: async () => "\n FIXER LAW \n",
        loadFixPacket: async () => emptyFixPacket,
      },
      expected: `BASE\n\n<fixer_soul>\nFIXER LAW\n</fixer_soul>\n\n<fixer_phase>\napply\n</fixer_phase>\n\n<fix_packet>\n${emptyFixPacket}\n</fix_packet>`,
    },
    {
      role: "coder",
      flags: { "ak-coder-task": "/task", "ak-coder-phase": "plan" },
      dependencies: {
        loadJudgeSoul: async () => "judge",
        loadCoderSoul: async () => "\n CODER LAW \n",
        loadCoderTask: async () => "\n TASK BODY \n",
      },
      expected: "BASE\n\n<coder_soul>\nCODER LAW\n</coder_soul>\n\n<coder_phase>\nplan\n</coder_phase>\n\n<coder_task>\nTASK BODY\n</coder_task>",
    },
  ] as const;

  for (const fixture of cases) {
    const harness = extensionHarness(fixture.role, fixture.flags);
    createRoleRuntimeExtension({
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" }),
      ...fixture.dependencies,
    })(harness.pi as ExtensionAPI);
    await harness.handlers.get("session_start")?.({}, {});
    const result = await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: "idle" },
      {},
    );
    assert.equal((result as { systemPrompt: string }).systemPrompt, fixture.expected);
  }
});

test("named Judge and worker tools preserve exact metadata, schema leaves, and receipts", async () => {
  const fixtures = [
    {
      role: "judge",
      flags: {},
      dependencies: { loadJudgeSoul: async () => "judge" },
      name: JUDGE_OUTPUT_TOOL_NAME,
      metadata: {
        label: "Judge Output",
        description: "Submit the final judge verdict. Soul compliance is audited before acceptance.",
        promptSnippet: "Submit the final judge verdict after adjudication",
        promptGuidelines: [`Use ${JUDGE_OUTPUT_TOOL_NAME} as the final action for the judge role.`],
      },
      output: { judgeStatus: "converged" },
      acceptedText: "Judge verdict accepted",
    },
    {
      role: "fixer",
      flags: { "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" },
      dependencies: {
        loadJudgeSoul: async () => "judge",
        loadFixerSoul: async () => "fixer",
        loadFixPacket: async () => emptyFixPacket,
      },
      name: FIXER_OUTPUT_TOOL_NAME,
      metadata: {
        label: "Fixer Output",
        description: "Submit the exact plan refusal or per-finding apply settlement for compliance audit.",
        promptSnippet: "Submit the final fixer report",
        promptGuidelines: [
          `Use ${FIXER_OUTPUT_TOOL_NAME} as the final action for the fixer role.`,
          `${FIXER_OUTPUT_TOOL_NAME} reports only lawful assignment blockers; infrastructure failures abort.`,
          "plan permits planned|refused; apply permits completed|refused|partially_completed.",
        ],
      },
      output: { status: "completed", report: "done", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] },
      acceptedText: "Fixer report accepted",
    },
    {
      role: "coder",
      flags: { "ak-coder-task": "/task", "ak-coder-phase": "plan" },
      dependencies: {
        loadJudgeSoul: async () => "judge",
        loadCoderSoul: async () => "coder",
        loadCoderTask: async () => "task",
      },
      name: CODER_OUTPUT_TOOL_NAME,
      metadata: {
        label: "Coder Output",
        description: "Submit a plan, completion, or evidence-bearing refusal for the active coder phase. commitSha is advisory evidence for the caller.",
        promptSnippet: "Submit the final coder report",
        promptGuidelines: [
          `Use ${CODER_OUTPUT_TOOL_NAME} as the final action for the coder role.`,
          `${CODER_OUTPUT_TOOL_NAME} never escalates; explain authority or task conflicts in report for the caller to dispose.`,
          "plan permits planned|refused; apply permits completed|refused.",
          "A completed apply report must preserve evidence for TDD, the same-pattern check, introduced-regression check, and behavior-fact check.",
        ],
      },
      output: { status: "planned", report: "plan" },
      acceptedText: "Coder report accepted",
    },
  ] as const;

  for (const fixture of fixtures) {
    const harness = extensionHarness(fixture.role, fixture.flags);
    createRoleRuntimeExtension({
      transcriptFromContext: () => "record",
      auditSoulCompliance: async () => ({ status: "pass", usage }),
      auditFixerCompliance: async () => ({ status: "pass", usage }),
      ...fixture.dependencies,
    })(harness.pi as ExtensionAPI);
    await harness.handlers.get("session_start")?.({}, {});
    assert.deepEqual([...harness.tools.keys()], [fixture.name]);
    const tool = harness.tools.get(fixture.name);
    assert.ok(tool);
    if (fixture.role === "fixer") {
      assert.equal(tool.name, FIXER_OUTPUT_TOOL_NAME);
      assert.ok(Array.isArray(tool.parameters.anyOf));
    } else {
      assert.deepEqual({
        label: tool.label,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
      }, fixture.metadata);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(
        Object.keys(tool.parameters.properties),
        fixture.role === "judge"
          ? ["judgeStatus", "fix", "classes", "note", "decisionGate"]
          : ["status", "report", "commitSha"],
      );
    }
    const result = await tool.execute(
      "receipt",
      fixture.output,
      undefined,
      undefined,
      toolCallContext([{ id: "receipt", name: fixture.name }]),
    );
    assert.equal(result.content[0].text, fixture.acceptedText);
    assert.deepEqual(result.details, fixture.output);
    assert.equal(result.terminate, true);
    assert.deepEqual(
      result.usage,
      fixture.role === "judge" || fixture.role === "fixer" ? usage : undefined,
    );
  }
});

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
    {
      judgeStatus: "continue",
      fix: { summary: "Repair the parser" },
      classes: [{
        name: "parser-contract",
        owner: "parser",
        boundary: "input parsing",
        disposition: "repair malformed input handling",
      }],
    },
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
      classes: [{ name: "LiveDefect", owner: "runtime", boundary: "live seam", disposition: "repair" }],
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

  const bareNativeHarness = await start();
  assert.deepEqual(
    await bareNativeHarness.handlers.get("input")?.(
      { text: "/skill:tdd" },
      {},
    ),
    { action: "continue" },
  );
  await bareNativeHarness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd("") },
    { abort() {}, mode: "tui" },
  );
  assert.deepEqual((await submitCompleted(bareNativeHarness, "bare-native")).details, completed);

  const collisionHarness = await start();
  assert.deepEqual(
    await collisionHarness.handlers.get("input")?.(
      { text: "/skill:tddfoo" },
      {},
    ),
    {
      action: "transform",
      text: "/skill:tdd /skill:tddfoo",
    },
  );
  await collisionHarness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd("/skill:tddfoo") },
    { abort() {}, mode: "tui" },
  );
  assert.deepEqual(
    (await submitCompleted(collisionHarness, "collision")).details,
    completed,
  );

  const tabSeparatedHarness = await start();
  assert.deepEqual(
    await tabSeparatedHarness.handlers.get("input")?.(
      { text: `/skill:tdd\t${request}` },
      {},
    ),
    {
      action: "transform",
      text: `/skill:tdd /skill:tdd\t${request}`,
    },
  );

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

test("Fixer activation parses and freezes the typed packet before any agent work", async () => {
  for (const source of ["# legacy Markdown", JSON.stringify({ version: 1, instructions: " ", prerequisites: [] })]) {
    const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.json", "ak-fixer-phase": "apply" });
    let audits = 0;
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "judge",
      loadFixerSoul: async () => "fixer",
      loadFixPacket: async () => source,
      transcriptFromContext: () => "record",
      auditSoulCompliance: async () => ({ status: "pass" }),
      auditFixerCompliance: async () => { audits += 1; return { status: "pass" }; },
    })(harness.pi as ExtensionAPI);
    await assert.rejects(Promise.resolve(harness.handlers.get("session_start")?.({}, {})), /FixPacketV1/);
    assert.equal(audits, 0);
    assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), false);
    assert.equal(harness.handlers.has("before_agent_start"), false);
  }
});

test("undeclared prerequisite submissions are correctable before audit and declared references receive one immutable audit input", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.json", "ak-fixer-phase": "apply" });
  const seen: unknown[] = [];
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer", loadFixPacket: async () => declaredFixPacket,
    transcriptFromContext: () => "record", auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async (input) => { seen.push(input); return { status: "pass", usage }; },
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
  const candidate = (prerequisiteId: string) => ({ status: "refused", report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId, evidence: "Choice absent." } }] });
  await assert.rejects(tool.execute("bad", candidate("other"), undefined, undefined, toolCallContext([{ id: "bad", name: FIXER_OUTPUT_TOOL_NAME }])), /Fixer output/);
  assert.equal(seen.length, 0);
  const accepted = await tool.execute("good", candidate("owner.choice"), undefined, undefined, toolCallContext([{ id: "good", name: FIXER_OUTPUT_TOOL_NAME }]));
  assert.equal(seen.length, 1);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen((seen[0] as any).packet), true);
  assert.equal(Object.isFrozen((seen[0] as any).candidate), true);
  assert.equal(Object.isFrozen((seen[0] as any).candidate.classResults[0].blocker), true);
  assert.deepEqual(accepted.details, candidate("owner.choice"));
  assert.deepEqual(accepted.usage, usage);
});

test("declared plan refusal, apply refusal, and partial apply each reach exactly one fresh audit", async () => {
  const rows = [
    { phase: "plan", candidate: { status: "refused", report: "Blocked.", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "Choice absent." } } },
    { phase: "apply", candidate: { status: "refused", report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "Choice absent." } }] } },
    { phase: "apply", candidate: { status: "partially_completed", report: "Mixed.", classResults: [{ name: "Done", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }, { name: "Policy", disposition: "refused", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "Choice absent." } }] } },
  ] as const;
  const auditInputs: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.json", "ak-fixer-phase": row.phase });
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer", loadFixPacket: async () => declaredFixPacket,
      transcriptFromContext: () => `record-${index}`, auditSoulCompliance: async () => ({ status: "pass" }),
      auditFixerCompliance: async (input) => { auditInputs.push(input); return { status: "pass", usage }; },
    })(harness.pi as ExtensionAPI);
    await harness.handlers.get("session_start")?.({}, {});
    const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
    const id = `declared-${index}`;
    const accepted = await tool.execute(id, row.candidate, undefined, undefined, toolCallContext([{ id, name: FIXER_OUTPUT_TOOL_NAME }]));
    assert.deepEqual(accepted.details, row.candidate);
  }
  assert.equal(auditInputs.length, 3);
  assert.equal(new Set(auditInputs).size, 3);
});

test("fixer role loads its typed JSON packet and returns a thin report envelope", async () => {
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
      return JSON.stringify({ version: 1, instructions: "REPAIR PACKET\nFix the live findings.", prerequisites: [] });
    },
    transcriptFromContext: () => "invocation record",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async () => ({ status: "pass" }),
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
        classResults: [{ name: "Guard", disposition: "refused", remainingScope: "requested guard", blocker: { cause: "authority_violation", evidence: "contradicts controlling authority" } }],
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
      classResults: [{ name: "Guard", disposition: "refused", remainingScope: "requested guard", blocker: { cause: "authority_violation", evidence: "contradicts controlling authority" } }],
    }
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
    loadFixPacket: async () => emptyFixPacket,
    transcriptFromContext: () => "record",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async () => ({ status: "pass" }),
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
    /Fixer output/i,
  );
  await assert.rejects(
    tool.execute(
      "commit-call",
      { status: "planned", report: "Plan only.", commitSha: "abc123" },
      undefined,
      undefined,
      toolCallContext([{ id: "commit-call", name: FIXER_OUTPUT_TOOL_NAME }]),
    ),
    /Fixer output/i,
  );
});

test("Fixer audits every structurally valid attempt freshly and revise permits corrected resubmission", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" });
  const seen: unknown[] = [];
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer", loadFixPacket: async () => emptyFixPacket,
    transcriptFromContext: () => "current invocation transcript", auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async (input) => { seen.push(input); return seen.length === 1 ? { status: "revise", violations: ["dishonest incomplete label"] } : { status: "pass" }; },
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
  const candidate = { status: "completed", report: "settled", classResults: [{ name: "Parser", disposition: "completed", searchScope: "all parsers", exceptions: [], commitSha: "a".repeat(40) }] };
  await assert.rejects(tool.execute("first", candidate, undefined, undefined, toolCallContext([{ id: "first", name: FIXER_OUTPUT_TOOL_NAME }])), /violates its law/);
  const accepted = await tool.execute("second", candidate, undefined, undefined, toolCallContext([{ id: "second", name: FIXER_OUTPUT_TOOL_NAME }]));
  assert.equal(seen.length, 2);
  assert.deepEqual(accepted.details, candidate);
  assert.notEqual(seen[0], seen[1]);
});

test("Fixer prospective prerequisite decisions survive the production submission lifecycle unchanged", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" });
  const decisions = [
    { status: "revise", violations: ["completed work was retrospectively relabeled as blocked"] },
    { status: "pass", violations: [] },
    { status: "pass", violations: [] },
  ] as const;
  let auditCalls = 0;
  const auditInputs: Context[] = [];
  const audit = createPiFixerAuditor(async (_model, request) => {
    auditInputs.push(request);
    return fauxAssistantMessage(
      fauxToolCall(FIXER_AUDIT_TOOL_NAME, decisions[auditCalls++]!),
      { stopReason: "toolUse" },
    );
  });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
    loadFixerSoul: async () => "fixer",
    loadFixPacket: async () => JSON.stringify({ version: 1, instructions: "A predecessor owner decision is required before work when the packet says so.", prerequisites: [{ id: "owner.choice", requirement: "The predecessor owner decision exists." }] }),
    transcriptFromContext: () => "Current invocation record and verification evidence.",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: audit,
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
  const productionBeforeRegressionRefusal = {
    status: "refused", report: "Both repairs and regressions exist, but commit ordering cannot be rewritten.",
    classResults: [{ name: "Binding", disposition: "refused", remainingScope: "retrospective test-first ordering", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "production commit preceded the regression commit" } }],
  };
  const correctedCompletion = {
    status: "completed", report: "The production change preceded its regression, so this does not claim TDD. Current focused and full verification pass.",
    classResults: [{ name: "Binding", disposition: "completed", searchScope: "all binding sites", exceptions: [], commitSha: "a".repeat(40) }],
  };
  const absentOwnerDecision = {
    status: "refused", report: "No work began because the packet-required owner decision is still absent and execution is presently inadmissible.",
    classResults: [{ name: "Policy", disposition: "refused", remainingScope: "the entire policy change", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "the packet requires an owner decision before editing, and no such decision exists" } }],
  };
  const auditedContext = (id: string) => Object.assign(toolCallContext([{ id, name: FIXER_OUTPUT_TOOL_NAME }]), {
    model: { provider: "active", id: "same-model" },
    modelRegistry: {
      async getProviderAuth() { return { auth: { apiKey: "secret" } }; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "secret" }; },
    },
  }) as ExtensionContext;

  await assert.rejects(
    tool.execute("retrospective", productionBeforeRegressionRefusal, undefined, undefined, auditedContext("retrospective")),
    /Fixer output violates its law/,
  );
  const corrected = await tool.execute("corrected", correctedCompletion, undefined, undefined, auditedContext("corrected"));
  const prerequisite = await tool.execute("prerequisite", absentOwnerDecision, undefined, undefined, auditedContext("prerequisite"));
  assert.deepEqual(corrected.details, correctedCompletion);
  assert.deepEqual(prerequisite.details, absentOwnerDecision);
  assert.equal(corrected.terminate, true);
  assert.equal(prerequisite.terminate, true);
  assert.equal(auditCalls, 3);
  for (const [index, candidate] of [productionBeforeRegressionRefusal, correctedCompletion, absentOwnerDecision].entries()) {
    const userContent = auditInputs[index]?.messages.find((message) => message.role === "user")?.content;
    assert.ok(Array.isArray(userContent));
    assert.equal(userContent.some((part) => part.type === "text" && part.text.includes(JSON.stringify(candidate))), true);
  }
});

test("worker output rejects malformed, unknown, blank, and non-object values", async () => {
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/packet",
    "ak-fixer-phase": "apply",
  });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
    loadFixerSoul: async () => "fixer",
    loadFixPacket: async () => emptyFixPacket,
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const malformed: unknown[] = [
    null,
    [],
    { status: "unknown", report: "report" },
    { status: "completed", report: " \n" },
    { status: "completed", report: "report", commitSha: " \n" },
    { status: "completed", report: "report", unknown: true },
    { status: "completed" },
  ];
  for (const [index, output] of malformed.entries()) {
    const id = `malformed-${index}`;
    await assert.rejects(
      tool.execute(
        id,
        output,
        undefined,
        undefined,
        toolCallContext([{ id, name: FIXER_OUTPUT_TOOL_NAME }]),
      ),
      /Fixer output/,
    );
  }
});

test("fixer output must be the sole call in its assistant batch", async () => {
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/materials/fix.md",
    "ak-fixer-phase": "apply",
  });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW",
    loadFixPacket: async () => emptyFixPacket,
    transcriptFromContext: () => "record",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await harness.handlers.get("session_start")?.({}, {});
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const output = { status: "completed", report: "Repaired and verified.", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] };
  const sibling = { id: "sibling", name: "read" };

  for (const calls of [
    [],
    [{ id: "wrong-id", name: FIXER_OUTPUT_TOOL_NAME }],
    [{ id: "fixer", name: CODER_OUTPUT_TOOL_NAME }],
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
    loadFixPacket: async () => emptyFixPacket,
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
    [],
    [{ id: "wrong-id", arguments: verdict }],
    [{ id: "judge", name: FIXER_OUTPUT_TOOL_NAME, arguments: verdict }],
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
  for (const sessionManager of [
    SessionManager.inMemory(),
    (() => {
      const manager = SessionManager.inMemory();
      manager.appendMessage({
        role: "user",
        content: "not a leaf call",
        timestamp: Date.now(),
      });
      return manager;
    })(),
  ]) {
    await assert.rejects(
      tool.execute(
        "judge",
        verdict,
        undefined,
        undefined,
        { sessionManager, abort() {} } as unknown as ExtensionContext,
      ),
      /sole final tool call/,
    );
  }
  assert.equal(auditCalls, 0);
});
