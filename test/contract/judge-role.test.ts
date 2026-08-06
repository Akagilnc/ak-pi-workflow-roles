import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Context, type Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { transcriptFromContext as productionTranscriptFromContext } from "../../extensions/role-runtime.ts";
import type { CanonicalSkillBinding } from "../../src/canonical-skill-binding.ts";
import { createPiFixerAuditor, FIXER_AUDIT_TOOL_NAME } from "../../src/fixer-auditor.ts";
import { createPiJudgeAuditor, SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { createJudgeRoleRuntime } from "../../src/judge-role.ts";
import { createNavigatorAttendance, type NavigatorPreparationSession } from "../../src/navigator-attendance.ts";
import { reviewerPromptIdentity } from "../../src/reviewer-prompt-identity.ts";
import {
  createCoderRoleRuntime,
  createFixerRoleRuntime,
} from "../../src/worker-role.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type JudgeVerdict,
  type SoulAuditInput,
} from "../../src/role-runtime.ts";
import {
  readTypedHttp429Observation,
  renderResumeCommand,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  extractNavigatorFact,
  formatTerminalResult,
  NAVIGATOR_POST_ROLE_GRACE_MS,
  settleJudgeFailureTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { withActivationHome } from "../helpers/pi-test-harness.ts";

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

const emptyFixPacket = "Repair the assigned findings.";
const declaredFixPrerequisites = JSON.stringify([{ id: "owner.choice", requirement: "Owner selects the contract." }]);

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


function activationCtx(home: string, extras: Record<string, unknown> = {}): ExtensionContext {
  // Durable session principal under the machine ledger book (ADR 0048).
  // Default mode stays undefined so failInfrastructure does not stamp process.exitCode unless a test opts in.
  const sessionDir = join(home, ".ak-roles", "books", basename(home), "runs", "judge-role", "session");
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(home, sessionDir);
  return {
    abort: () => {},
    ...extras,
    cwd: home,
    sessionManager,
  } as unknown as ExtensionContext;
}

async function startJudge(
  auditSoulCompliance: Parameters<
    typeof createRoleRuntimeExtension
  >[0]["auditSoulCompliance"],
  transcriptFromContext: (ctx: ExtensionContext) => string = () =>
    "review evidence and adjudication",
) {
  return withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    const harness = extensionHarness("judge");
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW\nApply the law.",
      transcriptFromContext,
      auditSoulCompliance,
    })(harness.pi as ExtensionAPI);
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    return { harness, tool };
  });
}

test("stable factory registers the complete typed role flag set and stays inert without a role", async () => {
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

  assert.deepEqual(new Set(harness.flags.keys()), new Set([
    "ak-role",
    "ak-fix-packet",
    "ak-fixer-prerequisites",
    "ak-fixer-phase",
    "ak-coder-task",
    "ak-coder-phase",
    "ak-review-task",
    "ak-review-capabilities",
    "ak-review-scope-keys",
    "ak-doctor-case",
    "ak-merger-input",
    "ak-collector-repo",
    "ak-collector-pr",
    "ak-collector-legs",
  ]));
  for (const [name, options] of harness.flags) {
    assert.equal((options as { type?: unknown }).type, "string", name);
  }
  assert.deepEqual(new Set(harness.handlers.keys()), new Set([
    "input",
    "before_agent_start",
    "session_start",
    "tool_result",
    "agent_settled",
    "session_shutdown",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "after_provider_response",
  ]));
  await harness.handlers.get("session_start")?.({}, {});
  assert.equal(loads, 0);
  assert.deepEqual([...harness.tools], []);
  assert.deepEqual(harness.activeToolSets, []);
  // Observation handlers are registered but stay inert without --ak-role admission.
  assert.equal(harness.handlers.has("tool_call"), false, "tool_call");
});

test("after_provider_response production handler writes typed 429 into resumable failure Terminal", async () => {
  // Shortest tracer: production handler → durable observation → public failure settlement → resume.
  // Does not call recordTypedProviderHttpStatus as a stand-in for the observation seam.
  await withActivationHome({ prefix: "ak-typed-429-obs-" }, async ({ home }) => {
    const runId = "run-prod-obs-429";
    const runDirectory = join(home, ".ak-roles", "books", basename(home), "runs", `${runId}@judge`);
    const sessionDirectory = join(runDirectory, "session");
    mkdirSync(sessionDirectory, { recursive: true });
    const admittedRequestPath = join(runDirectory, "admitted-request.json");
    await writeFile(admittedRequestPath, "{}\n", "utf8");

    const harness = extensionHarness(undefined);
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "judge",
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" }),
    })(harness.pi as ExtensionAPI);

    const handler = harness.handlers.get("after_provider_response");
    assert.ok(handler, "production after_provider_response handler must be registered");

    // Without AK_ROLE_RUN_DIR the handler is inert.
    await handler(
      { type: "after_provider_response", status: 429, headers: {} },
      { model: { provider: "openai-codex" } },
    );
    assert.equal(await readTypedHttp429Observation(runDirectory), undefined);

    const previous = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = runDirectory;
    try {
      // Non-v1 provider ignored.
      await handler(
        { type: "after_provider_response", status: 429, headers: {} },
        { model: { provider: "anthropic" } },
      );
      assert.equal(await readTypedHttp429Observation(runDirectory), undefined);

      // Production typed 429 observation.
      await handler(
        { type: "after_provider_response", status: 429, headers: {} },
        { model: { provider: "openai-codex" } },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AK_ROLE_RUN_DIR;
      } else {
        process.env.AK_ROLE_RUN_DIR = previous;
      }
    }

    assert.deepEqual(await readTypedHttp429Observation(runDirectory), {
      httpStatus: 429,
      provider: "openai-codex",
    });

    const terminal = await settleJudgeFailureTerminalResult(
      {
        role: "judge",
        runId,
        bookKey: basename(home),
        projectRoot: home,
        instruction: "observe",
        instructionEmpty: false,
        attachments: [],
        runDirectory,
        sessionDirectory,
        admittedRequestPath,
      },
      { cause: "provider", diagnostic: "upstream declined this request" },
      { disposition: "no-advice" },
      { resume: { command: renderResumeCommand(runId) } },
    );

    assert.ok(terminal.resume);
    assert.equal(terminal.resume.command, renderResumeCommand(runId));
    assert.equal(terminal.runId, undefined);
    assert.equal(terminal.artifacts.length, 0);
    const outside = {
      roleOutcome: terminal.roleOutcome,
      navigator: terminal.navigator,
      artifacts: terminal.artifacts,
      runId: terminal.runId,
    };
    assert.equal(
      JSON.stringify(outside).includes(runId),
      false,
      "run ID must not appear outside resume.command in typed Terminal regions",
    );
    const presented = formatTerminalResult(terminal);
    assert.equal(presented.includes(terminal.resume.command), true);
    assert.equal(
      presented.split(terminal.resume.command).join("").includes(runId),
      false,
    );
  });
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
  const harness = extensionHarness(undefined, {}, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "write",
    "edit",
    "arbitrary_sibling",
  ]);
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
  assert.deepEqual(harness.activeToolSets, [[
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    JUDGE_OUTPUT_TOOL_NAME,
  ]]);
  assert.equal(
    (await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {},
    ) as { systemPrompt: string }).systemPrompt,
    "BASE\n\n<judge_soul>\nJUDGE LAW\n</judge_soul>",
  );
});

test("focused Fixer and Coder controllers own their flags, lifecycle hooks, and prompt envelopes", async () => {
  const fixer = extensionHarness(undefined, {
    "ak-fix-packet": "/packet.md",
    "ak-fixer-phase": "plan",
  });
  const fixerRuntime = createFixerRoleRuntime(
    fixer.pi as ExtensionAPI,
    {
      loadSoul: async () => "\n FIXER LAW \n",
      loadPacket: async () => emptyFixPacket,
      transcriptFromContext: () => "record",
      auditCompliance: async () => ({ status: "pass" }),
    },
  );
  assert.deepEqual(new Set(fixer.flags.keys()), new Set(["ak-fix-packet", "ak-fixer-prerequisites", "ak-fixer-phase"]));
  await fixerRuntime.activate();
  assert.deepEqual([...fixer.tools.keys()], [FIXER_OUTPUT_TOOL_NAME]);
  assert.ok(fixer.handlers.has("before_agent_start"));
  assert.equal(fixer.handlers.has("input"), false);
  assert.equal(
    (await fixer.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {},
    ) as { systemPrompt: string }).systemPrompt,
    `BASE\n\n<fixer_soul>\nFIXER LAW\n</fixer_soul>\n\n<fixer_phase>\nplan\n</fixer_phase>\n\n<fix_packet>\n${emptyFixPacket}\n</fix_packet>\n\n<fixer_prerequisites>\n[]\n</fixer_prerequisites>`,
  );
  const fixerTool = fixer.tools.get(FIXER_OUTPUT_TOOL_NAME);
  assert.ok(fixerTool);
  assert.deepEqual(
    (await fixerTool.execute(
      "plan-call",
      { status: "planned", report: "Plan the smallest repair." },
      undefined,
      undefined,
      toolCallContext([{ id: "plan-call", name: FIXER_OUTPUT_TOOL_NAME }]),
    )).details,
    { status: "planned", report: "Plan the smallest repair." },
  );
  await assert.rejects(
    fixerTool.execute(
      "completed-call",
      { status: "completed", report: "Implemented it.", classResults: [{ name: "C", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] },
      undefined,
      undefined,
      toolCallContext([{ id: "completed-call", name: FIXER_OUTPUT_TOOL_NAME }]),
    ),
    /Fixer output/i,
  );

  const coder = extensionHarness(undefined, {
    "ak-coder-task": "/task.md",
    "ak-coder-phase": "plan",
  });
  const coderRuntime = createCoderRoleRuntime(
    coder.pi as ExtensionAPI,
    {
      loadSoul: async () => "\n CODER LAW \n",
      loadTask: async () => "\n TASK BODY \n",
    },
    { failInfrastructure(error) { throw error; } },
  );
  assert.deepEqual(new Set(coder.flags.keys()), new Set(["ak-coder-task", "ak-coder-phase"]));
  await coderRuntime.activate();
  assert.deepEqual([...coder.tools.keys()], [CODER_OUTPUT_TOOL_NAME]);
  assert.ok(coder.handlers.has("before_agent_start"));
  assert.ok(coder.handlers.has("input"));
  assert.equal(
    (await coder.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {},
    ) as { systemPrompt: string }).systemPrompt,
    "BASE\n\n<coder_soul>\nCODER LAW\n</coder_soul>\n\n<coder_phase>\nplan\n</coder_phase>\n\n<coder_task>\nTASK BODY\n</coder_task>",
  );
});

test("named Judge and worker tools preserve schema leaves and receipts", async () => {
  const fixtures = [
    {
      role: "judge" as const,
      name: JUDGE_OUTPUT_TOOL_NAME,
      activate: async () => {
        const harness = extensionHarness(undefined);
        const runtime = createJudgeRoleRuntime(
          harness.pi as ExtensionAPI,
          {
            loadSoul: async () => "judge",
            transcriptFromContext: () => "record",
            auditSoulCompliance: async () => ({ status: "pass", usage }),
          },
          { failInfrastructure(error) { throw error; } },
        );
        await runtime.activate();
        return harness;
      },
      output: { judgeStatus: "converged", evidence: { checks: [{ name: "receipt", passed: true }] } },
      acceptedText: "Judge verdict accepted",
    },
    {
      role: "fixer" as const,
      name: FIXER_OUTPUT_TOOL_NAME,
      activate: async () => {
        const harness = extensionHarness(undefined, {
          "ak-fix-packet": "/packet",
          "ak-fixer-phase": "apply",
        });
        const runtime = createFixerRoleRuntime(
          harness.pi as ExtensionAPI,
          {
            loadSoul: async () => "fixer",
            loadPacket: async () => emptyFixPacket,
            transcriptFromContext: () => "record",
            auditCompliance: async () => ({ status: "pass", usage }),
          },
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "completed", report: "done", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] },
      acceptedText: "Fixer report accepted",
    },
    {
      role: "coder" as const,
      name: CODER_OUTPUT_TOOL_NAME,
      activate: async () => {
        const harness = extensionHarness(undefined, {
          "ak-coder-task": "/task",
          "ak-coder-phase": "plan",
        });
        const runtime = createCoderRoleRuntime(
          harness.pi as ExtensionAPI,
          {
            loadSoul: async () => "coder",
            loadTask: async () => "task",
          },
          { failInfrastructure(error) { throw error; } },
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "planned", report: "plan" },
      acceptedText: "Coder report accepted",
    },
  ];

  for (const fixture of fixtures) {
    const harness = await fixture.activate();
    assert.deepEqual([...harness.tools.keys()], [fixture.name]);
    const tool = harness.tools.get(fixture.name);
    assert.ok(tool);
    assert.equal(tool.name, fixture.name);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    assert.ok(
      (tool.promptGuidelines ?? []).some((line) => line.includes(fixture.name)),
      `${fixture.name} guidelines must name the tool`,
    );
    if (fixture.role === "judge") {
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(Object.keys(tool.parameters.properties), ["judgeStatus", "fix", "classes", "note", "evidence", "decisionGate"]);
    } else if (fixture.role === "fixer") {
      assert.ok(Array.isArray(tool.parameters.anyOf));
    } else {
      assert.ok(Array.isArray(tool.parameters.anyOf));
      assert.deepEqual(tool.parameters.anyOf.map((branch: { properties: Record<string, unknown> }) => Object.keys(branch.properties)), [
        ["status", "report"],
        ["status", "report"],
        ["status", "report", "remainingScope"],
      ]);
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

test("production Judge-to-Soul audit projection ignores opaque evidence and preserves receipt details", async () => {
  const auditRequests: Context[] = [];
  const auditor = createPiJudgeAuditor(async (_model, request) => {
    auditRequests.push(request);
    return fauxAssistantMessage(
      fauxToolCall(SOUL_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      { stopReason: "toolUse" },
    );
  });
  const { tool } = await startJudge(auditor, productionTranscriptFromContext);
  const auditedContext = (id: string, verdict: JudgeVerdict) => Object.assign(
    toolCallContext([{ id, arguments: verdict }]),
    {
      model: { provider: "active", id: "judge" },
      modelRegistry: {
        async getProviderAuth() {
          return { auth: { apiKey: "secret" } };
        },
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "secret" };
        },
      },
    },
  ) as ExtensionContext;
  const withoutEvidence: JudgeVerdict = { judgeStatus: "converged" };
  const evidence = { opaqueOnly: "must not reach the auditor" } as const;
  const withEvidence: JudgeVerdict = { judgeStatus: "converged", evidence };

  const withoutReceipt = await tool.execute(
    "without-evidence",
    withoutEvidence,
    undefined,
    undefined,
    auditedContext("without-evidence", withoutEvidence),
  );
  const withReceipt = await tool.execute(
    "with-evidence",
    withEvidence,
    undefined,
    undefined,
    auditedContext("with-evidence", withEvidence),
  );

  assert.equal(auditRequests.length, 2);
  const serializedAuditInput = (request: Context): string => {
    assert.equal(request.messages.length, 1);
    const [user] = request.messages;
    assert.ok(user?.role === "user");
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content.length, 1);
    const [part] = user.content;
    assert.ok(part?.type === "text");
    return part.text;
  };
  const firstAuditText = serializedAuditInput(auditRequests[0]!);
  const secondAuditText = serializedAuditInput(auditRequests[1]!);
  assert.deepEqual(
    Buffer.from(firstAuditText, "utf8"),
    Buffer.from(secondAuditText, "utf8"),
  );
  assert.match(
    firstAuditText,
    /\[Assistant tool calls\]: ak_judge_output\(judgeStatus="converged"\)/,
  );
  assert.doesNotMatch(firstAuditText, /evidence|opaqueOnly/);
  assert.equal(withoutReceipt.terminate, true);
  assert.equal(withReceipt.terminate, true);
  assert.deepEqual(withoutReceipt.details, withoutEvidence);
  assert.deepEqual(withReceipt.details, withEvidence);
  assert.equal(withReceipt.details.evidence, evidence);
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

test("packaged infrastructure failure silence correlates the exact output call in either sibling order", async () => {
  for (const order of ["failure-first", "sibling-first"] as const) {
    const harness = extensionHarness("judge");
    const previousExitCode = process.exitCode;
    const events: unknown[] = [];
    const entries: unknown[] = [];
    let navigatorTool: Tool | undefined;
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    let preparationReady!: () => void;
    const preparationStartedPromise = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const preparationReadyPromise = new Promise<void>((resolve) => { preparationReady = resolve; });
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const navigatorSession: NavigatorPreparationSession = {
      async prompt() {
        preparationStarted();
        await preparationGate;
      },
      appendEntry(customType, data) {
        entries.push({ type: "custom", customType, data });
      },
      entries: () => entries,
      dispose() {},
    };
    let navigator: ReturnType<typeof createNavigatorAttendance> | undefined;
    const extension = createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW",
      transcriptFromContext: () => "record",
      auditSoulCompliance: async () => { throw new Error("provider quota exhausted"); },
      loadNavigatorWorkContext: async () => ({ subjectKey: "/repo/.ak/work/issues/28", subject: "issue 28", authority: "owner authority", subjectProvenance: "role_input" as const }),
      createNavigatorAttendance: async (options) => {
        navigator = createNavigatorAttendance({
          ...options,
          sessionDir: "/repo/.ak/work/issues/28/runs/navigator",
          modelSettingPath: "/missing/navigator-model.json",
          loadSoul: async () => "route law",
          loadRoleHelp: async (role) => `Usage: pi --ak-role ${role} --help`,
          createSession: async ({ tool }) => {
            navigatorTool = tool as Tool;
            preparationReady();
            return navigatorSession;
          },
          onEvent: async (event) => { events.push(event); },
        });
        return navigator;
      },
    });
    extension(harness.pi as ExtensionAPI);
    await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
      const ctx = activationCtx(home, { mode: "print" });
      await harness.handlers.get("session_start")?.({}, ctx);
      assert.ok(navigator);
      navigator.prepare();
      await preparationReadyPromise;
      await preparationStartedPromise;
      assert.ok(navigatorTool);
      const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
      assert.ok(tool);
      const verdict = { judgeStatus: "converged" };
      await assert.rejects(
        tool.execute("failed-output", verdict, undefined, undefined, toolCallContext([{ id: "failed-output", arguments: verdict }])),
        /provider quota exhausted/,
      );
      const sibling = { toolName: "read", toolCallId: "sibling", isError: false, details: {} };
      const failure = { toolName: JUDGE_OUTPUT_TOOL_NAME, toolCallId: "failed-output", isError: true, details: { message: "native provider wording" } };
      const wrong = { ...failure, toolCallId: "other-output" };
      await harness.handlers.get("tool_result")?.(wrong, ctx);
      let failureSettlement: unknown;
      if (order === "failure-first") {
        failureSettlement = harness.handlers.get("tool_result")?.(failure, ctx);
        await harness.handlers.get("tool_result")?.(sibling, ctx);
      } else {
        await harness.handlers.get("tool_result")?.(sibling, ctx);
        failureSettlement = harness.handlers.get("tool_result")?.(failure, ctx);
      }
      let drained = false;
      void Promise.resolve(failureSettlement).then(() => { drained = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false, "in-flight healthy preparation must hold the output settlement");
      assert.deepEqual(events, [], "infrastructure failure must not publish advice");
      releasePreparation();
      await failureSettlement;
      assert.equal(drained, true);
      const settlement = entries.find((entry: any) => entry.customType === "ak-navigator-settlement") as any;
      assert.ok(settlement?.data);
      const { invocationId, ...typedSettlement } = settlement.data;
      assert.equal(typeof invocationId, "string");
      assert.deepEqual(typedSettlement, {
        subjectKey: "/repo/.ak/work/issues/28",
        role: "judge",
        phase: null,
        kind: "role_infrastructure_failure",
      });
      assert.equal(events.length, 0, "no late Navigator message may follow infrastructure silence");
      await harness.handlers.get("agent_settled")?.({}, ctx);
      process.exitCode = previousExitCode;
    });
  }
});

test("judge role fails before adjudication when its soul is empty", async () => {
  const harness = extensionHarness("judge");
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "   \n",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  });

  extension(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await assert.rejects(
      Promise.resolve(harness.handlers.get("session_start")?.({}, activationCtx(home))),
      /Judge soul is empty/,
    );
  });
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

  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
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
  assert.equal(
    prompt,
    "BASE\n\n<coder_soul>\nCODER LAW\n</coder_soul>\n\n<coder_phase>\nplan\n</coder_phase>\n\n<coder_task>\nIMPLEMENT THE VERTICAL SLICE\n</coder_task>",
  );
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
  await assert.rejects(
    tool.execute(
      "coder-unfinished-plan",
      { status: "unfinished", report: "Not finished.", remainingScope: "the implementation" },
      undefined,
      undefined,
      toolCallContext([{ id: "coder-unfinished-plan", name: CODER_OUTPUT_TOOL_NAME }]),
    ),
    /Coder plan phase permits only planned or refused/,
  );
});

test("coder apply accepts an unfinished handoff with typed remaining scope", async () => {
  const harness = extensionHarness("coder", {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadCoderSoul: async () => "CODER LAW",
    loadCoderTask: async () => "APPROVED IMPLEMENTATION PLAN",
    loadCanonicalSkillBinding: async () => tddBinding(),
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const unfinished = {
    status: "unfinished" as const,
    report: "The first implementation is not fully settled.",
    remainingScope: "the unimplemented adapter branch",
  };
  assert.deepEqual(
    (await tool.execute("unfinished", unfinished, undefined, undefined, toolCallContext([{ id: "unfinished", name: CODER_OUTPUT_TOOL_NAME }]))).details,
    unfinished,
  );
  const invalids = [
    { status: "unfinished", report: "still working" },
    { status: "unfinished", report: "still working", remainingScope: " " },
    { status: "unfinished", report: "still working", remainingScope: "scope", commitSha: "abc" },
  ];
  for (const [index, invalid] of invalids.entries()) {
    const id = `invalid-${index}`;
    await assert.rejects(
      tool.execute(id, invalid, undefined, undefined, toolCallContext([{ id, name: CODER_OUTPUT_TOOL_NAME }])),
      /Coder unfinished output|additional property|remainingScope/i,
    );
  }
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
    await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
      await harness.handlers.get("session_start")?.({}, activationCtx(home));
    });
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

  // One must-reject malformed expansion proves the completed-gate (law ③);
  // the full malformed spelling matrix lives in canonical-skill-binding tests.
  {
    const harness = await start();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request).replace(tddBody, "# Canonical TDD") },
      { abort() {}, mode: "tui" },
    );
    await assert.rejects(
      submitCompleted(harness, "malformed-gate"),
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
    /Coder apply phase permits only completed, unfinished, or refused/,
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

test("Fixer activation rejects malformed prerequisites and blank instructions before installing its tool", async () => {
  const rows = [
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" }, packet: "{", diagnostic: /Fixer prerequisite/ },
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" }, packet: JSON.stringify([{ id: "bad/id", requirement: "x" }]), diagnostic: /Fixer prerequisite/ },
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-phase": "apply" }, packet: "", diagnostic: /Fixer instructions must be nonblank/ },
    { flags: { "ak-fix-packet": "/packet.md", "ak-fixer-phase": "apply" }, packet: " \t\n", diagnostic: /Fixer instructions must be nonblank/ },
  ] as const;
  for (const row of rows) {
    const harness = extensionHarness("fixer", row.flags);
    let audits = 0;
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "judge",
      loadFixerSoul: async () => "fixer",
      loadFixPacket: async () => row.packet,
      transcriptFromContext: () => "record",
      auditSoulCompliance: async () => ({ status: "pass" }),
      auditFixerCompliance: async () => { audits += 1; return { status: "pass" }; },
    })(harness.pi as ExtensionAPI);
    await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
      await assert.rejects(Promise.resolve(harness.handlers.get("session_start")?.({}, activationCtx(home))), row.diagnostic);
    });
    assert.equal(audits, 0);
    assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), false);
    assert.equal(harness.handlers.has("before_agent_start"), true);
  }
});

test("undeclared prerequisite submissions are correctable before audit and declared references receive one immutable audit input", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" });
  const seen: unknown[] = [];
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer", loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n",
    transcriptFromContext: () => "record", auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async (input) => { seen.push(input); return { status: "pass", usage }; },
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
  const candidate = (prerequisiteId: string) => ({ status: "refused", report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId, evidence: "Choice absent." } }] });
  await assert.rejects(tool.execute("bad", candidate("other"), undefined, undefined, toolCallContext([{ id: "bad", name: FIXER_OUTPUT_TOOL_NAME }])), /Fixer output/);
  assert.equal(seen.length, 0);
  // One tool-route malformed gate (validator matrix lives in fixer-contract).
  await assert.rejects(tool.execute("null", null, undefined, undefined, toolCallContext([{ id: "null", name: FIXER_OUTPUT_TOOL_NAME }])), /Fixer output/);
  assert.equal(seen.length, 0);
  const accepted = await tool.execute("good", candidate("owner.choice"), undefined, undefined, toolCallContext([{ id: "good", name: FIXER_OUTPUT_TOOL_NAME }]));
  assert.equal(seen.length, 1);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen((seen[0] as any).packet), true);
  assert.equal(Object.isFrozen((seen[0] as any).candidate), true);
  assert.equal(Object.isFrozen((seen[0] as any).candidate.classResults[0].blocker), true);
  assert.deepEqual(accepted.details, candidate("owner.choice"));
  assert.deepEqual(accepted.usage, usage);

  // Second lawful declared shape on the same harness: distinct frozen audit input.
  const partial = {
    status: "partially_completed" as const,
    report: "Mixed.",
    classResults: [
      { name: "Done", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
      { name: "Policy", disposition: "refused" as const, remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "owner.choice", evidence: "Choice absent." } },
    ],
  };
  const second = await tool.execute("partial", partial, undefined, undefined, toolCallContext([{ id: "partial", name: FIXER_OUTPUT_TOOL_NAME }]));
  assert.deepEqual(second.details, partial);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(Object.isFrozen(seen[1]), true);

  // Shared-commit acceptance audits exactly once more; rejections never reach audit.
  const sharedCommit = "shared-commit";
  const classA = { name: "Reviewer diagnostics", disposition: "completed" as const, searchScope: "reviewer admission and dispatch", exceptions: [], commitSha: sharedCommit };
  const classB = { name: "Fixer projection", disposition: "completed" as const, searchScope: "fixer output branches", exceptions: [], commitSha: sharedCommit };
  const shared = await tool.execute("shared", { status: "completed", report: "Both classes settled.", classResults: [classA, classB] }, undefined, undefined, toolCallContext([{ id: "shared", name: FIXER_OUTPUT_TOOL_NAME }]));
  assert.equal(shared.terminate, true);
  assert.deepEqual(shared.details.classResults, [classA, classB]);
  assert.equal(seen.length, 3);
  await assert.rejects(
    tool.execute("duplicate-name", { status: "completed", report: "invalid", classResults: [classA, { ...classB, name: classA.name }] }, undefined, undefined, toolCallContext([{ id: "duplicate-name", name: FIXER_OUTPUT_TOOL_NAME }])),
    /classResults name unique constraint/,
  );
  assert.equal(seen.length, 3);
});

test("declared plan refusal reaches exactly one fresh audit", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "plan" });
  const auditInputs: unknown[] = [];
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer",
    loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n",
    transcriptFromContext: () => "plan-record", auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async (input) => { auditInputs.push(input); return { status: "pass", usage }; },
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
  const candidate = { status: "refused", report: "Blocked.", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "Choice absent." } };
  const accepted = await tool.execute("plan-refused", candidate, undefined, undefined, toolCallContext([{ id: "plan-refused", name: FIXER_OUTPUT_TOOL_NAME }]));
  assert.deepEqual(accepted.details, candidate);
  assert.equal(auditInputs.length, 1);
  assert.equal(Object.isFrozen(auditInputs[0]), true);
});

test("fixer role loads opaque instructions and returns a thin report envelope", async () => {
  const loadedPaths: string[] = [];
  const instructionBytes = "  REPAIR INSTRUCTIONS\nFix the live findings.\n\n";
  const harness = extensionHarness("fixer", {
    "ak-fix-packet": "/materials/fix.md",
    "ak-fixer-phase": "apply",
  });
  const extension = createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    loadFixerSoul: async () => "FIXER LAW\nCreate one forward commit.",
    loadFixPacket: async (path) => {
      loadedPaths.push(path);
      return instructionBytes;
    },
    transcriptFromContext: () => "invocation record",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: async () => ({ status: "pass" }),
  });

  extension(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const promptResult = await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE SYSTEM PROMPT" },
    {},
  );

  assert.deepEqual(loadedPaths, ["/materials/fix.md"]);
  const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
  assert.equal(
    prompt,
    `BASE SYSTEM PROMPT\n\n<fixer_soul>\nFIXER LAW\nCreate one forward commit.\n</fixer_soul>\n\n<fixer_phase>\napply\n</fixer_phase>\n\n<fix_packet>\n${instructionBytes}\n</fix_packet>\n\n<fixer_prerequisites>\n[]\n</fixer_prerequisites>`,
  );
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

test("Fixer prospective prerequisite decisions survive the production submission lifecycle unchanged", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" });
  const decisions = [
    { status: "revise", violations: ["completed work was retrospectively relabeled as blocked"], conflicts: [], decisionGate: null },
    { status: "pass", violations: [], conflicts: [], decisionGate: null },
    { status: "pass", violations: [], conflicts: [], decisionGate: null },
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
    loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? JSON.stringify([{ id: "owner.choice", requirement: "The predecessor owner decision exists." }]) : "A predecessor owner decision is required before work when the packet says so.",
    transcriptFromContext: () => "Current invocation record and verification evidence.",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditFixerCompliance: audit,
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
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
  assert.notEqual(auditInputs[0], auditInputs[1]);
  for (const [index, candidate] of [productionBeforeRegressionRefusal, correctedCompletion, absentOwnerDecision].entries()) {
    const userContent = auditInputs[index]?.messages.find((message) => message.role === "user")?.content;
    assert.ok(Array.isArray(userContent));
    assert.equal(userContent.some((part) => part.type === "text" && part.text.includes(JSON.stringify(candidate))), true);
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
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
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

  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
  });
  assert.deepEqual(harness.activeToolSets, []);
  assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), true);
});

test("judge role rejects mixed verdict shapes before soul audit", async () => {
  // Shape matrix lives in judge-output-contract; one gate proves ordering (law ③).
  let auditCalls = 0;
  const { tool } = await startJudge(async () => {
    auditCalls += 1;
    return { status: "pass" };
  });
  const verdict = { judgeStatus: "converged", fix: { summary: "x" } };
  await assert.rejects(
    tool.execute(
      "invalid-gate",
      verdict,
      undefined,
      undefined,
      toolCallContext([{ id: "invalid-gate", arguments: verdict }]),
    ),
    /Judge converged/,
  );
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

test(
  "accepted role terminal races production 10s Navigator grace through role-runtime to Terminal",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(NAVIGATOR_POST_ROLE_GRACE_MS, 10_000);

    const modelRoot = await mkdtemp(join(tmpdir(), "ak-judge-grace-model-"));
    const modelSettingPath = join(modelRoot, "navigator-model.json");
    await writeFile(modelSettingPath, JSON.stringify({ model: "provider/model" }), "utf8");

    try {
      const harness = extensionHarness("judge");
      const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
      (harness.pi as { sendMessage?: (message: unknown) => Promise<void> }).sendMessage = async (
        message: unknown,
      ) => {
        sentMessages.push(message as { customType?: string; details?: unknown });
      };

      let releasePreparation!: () => void;
      let preparationStarted!: () => void;
      const preparationStartedPromise = new Promise<void>((resolve) => {
        preparationStarted = resolve;
      });
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      let disposeCalls = 0;
      const events: unknown[] = [];
      let attendance: ReturnType<typeof createNavigatorAttendance> | undefined;

      const extension = createRoleRuntimeExtension({
        loadJudgeSoul: async () => "JUDGE LAW",
        transcriptFromContext: () => "record",
        auditSoulCompliance: async () => ({ status: "pass" }),
        loadNavigatorWorkContext: async () => ({
          subjectKey: "/repo/.ak/work/issues/106",
          subject: "issue 106",
          authority: "owner authority",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: async (options) => {
          attendance = createNavigatorAttendance({
            ...options,
            sessionDir: join(modelRoot, "navigator-session"),
            modelSettingPath,
            loadSoul: async () => "route law",
            loadRoleHelp: async (role) => `Usage: pi --ak-role ${role} --help`,
            createSession: async () => ({
              async prompt() {
                preparationStarted();
                await preparationGate;
              },
              appendEntry() {},
              entries: () => [],
              dispose() {
                disposeCalls += 1;
              },
            }),
            onEvent: async (event, report) => {
              events.push(event);
              await options.onEvent(event, report);
            },
          });
          return attendance;
        },
      });
      extension(harness.pi as ExtensionAPI);

      await withActivationHome({ prefix: "ak-judge-grace-" }, async ({ home }) => {
        const ctx = activationCtx(home);
        await harness.handlers.get("session_start")?.({}, ctx);
        assert.ok(attendance, "Navigator attendance must be installed on session_start");
        // Start in-flight preparation that will outlive the post-role grace.
        // Call the production attendance directly (same object role-runtime holds).
        attendance.prepare();
        await preparationStartedPromise;

        // Real role-runtime tool_result → raceNavigatorGrace(default setTimeout sleep).
        // Start the handler, flush to the production timer, then advance the grace ceiling.
        const toolResultPending = harness.handlers.get("tool_result")?.({
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          toolCallId: "accepted-grace",
          isError: false,
          details: { judgeStatus: "converged", note: "ok" },
        }, ctx);
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(NAVIGATOR_POST_ROLE_GRACE_MS);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await toolResultPending;

        assert.ok(disposeCalls >= 1, "late attendance must be disposed after grace timeout");

        await harness.handlers.get("agent_settled")?.({}, ctx);
        assert.equal(sentMessages.length, 1);
        const details = sentMessages[0]?.details as {
          disposition?: string;
          unavailableReason?: string;
          unavailableSource?: string;
          invocationId?: string;
        };
        assert.equal(details.disposition, "unavailable");
        assert.equal(details.invocationId, "post-role-grace-timeout");
        assert.match(String(details.unavailableReason), /post-role delivery grace/);
        assert.equal(details.unavailableSource, "unknown");

        // Late preparation completion must not overwrite the grace unavailable fact.
        releasePreparation();
        const lateDrain = new Promise<void>((resolve) => setTimeout(resolve, 20));
        t.mock.timers.tick(20);
        await lateDrain;
        assert.equal(
          events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              (event as { disposition?: string }).disposition === "recommendation",
          ),
          false,
          "disposed late completion must not publish recommendation",
        );

        // Session attendance fact → typed Terminal navigator (settlement owner, not presentation).
        const navigator = extractNavigatorFact([
          {
            type: "custom_message",
            customType: "ak-navigator-attendance",
            message: { details },
          },
        ]);
        assert.equal(navigator.disposition, "unavailable");
        if (navigator.disposition === "unavailable") {
          assert.match(navigator.reason, /post-role delivery grace/);
        }
        const terminal = {
          roleOutcome: {
            kind: "accepted" as const,
            role: "judge" as const,
            status: "converged",
            decisiveFacts: { judgeStatus: "converged" },
          },
          navigator,
          artifacts: [{ kind: "report" as const, path: "/r/artifacts/report.json" }],
          runId: "run-grace-1",
        };
        assert.equal(terminal.roleOutcome.status, "converged");
        assert.equal(terminal.navigator.disposition, "unavailable");
        // Presentation accepts the typed result once; labels remain unfrozen.
        const formatted = formatTerminalResult(terminal);
        assert.ok(formatted.length > 0);
      });
    } finally {
      await rm(modelRoot, { recursive: true, force: true });
    }
  },
);
