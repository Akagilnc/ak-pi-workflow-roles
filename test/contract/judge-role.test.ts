import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context, type Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { transcriptFromContext as productionTranscriptFromContext } from "../../extensions/role-runtime.ts";
import { isAuditEscalationResult } from "../../src/audit-escalation.ts";
import type { CanonicalSkillBinding } from "../../src/canonical-skill-binding.ts";
import { createPiJudgeAuditor, SOUL_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { createJudgeRoleRuntime } from "../../src/judge-role.ts";
import {
  NOTARY_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  GATEKEEPER_OUTPUT_TOOL,
  GatekeeperDecisionError,
  type GatekeeperPassHostActions,
} from "../../src/gatekeeper-role.ts";
import {
  createNavigatorAttendance,
  type NavigatorEvent,
  type NavigatorPreparationSession,
} from "../../src/navigator-attendance.ts";
import { NAVIGATOR_INVOCATION_ENTRY } from "../../src/navigator-invocation-identity.ts";
import {
  createCoderRoleRuntime,
  createFixerRoleRuntime,
} from "../../src/worker-role.ts";
import { WorkerUnfinishedReasonReminderError } from "../../src/worker-submission-gates.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type JudgeVerdict,
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
import {
  clearPersistentSeatConfig,
  savePublicCliConfig,
  setPersistentSeatConfig,
  type PublicCliConfig,
} from "../../src/public-cli/config.ts";
import { scriptedGatekeeperModelRegistry } from "../helpers/faux-gatekeeper.ts";
import { packageRoot, withActivationHome } from "../helpers/pi-test-harness.ts";

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
      snapshotIdentity: Object.freeze({ text: `---\nname: tdd\ndescription: test\n---\n\n${tddBody}` }),
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
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
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
    /** Production seam: shared lifecycle persists principal via pi.appendEntry. */
    appendEntry(customType: string, data?: unknown) {
      appendedEntries.push({ customType, data });
    },
  };
  return { pi, handlers, tools, flags, activeToolSets, appendedEntries };
}

/** Test host: infrastructure throws through; non-pass bind is a no-op unless a case wires tool_result. */
function testHostActions(
  fail: (error: unknown) => never = (error): never => {
    throw error instanceof Error ? error : new Error(String(error));
  },
): GatekeeperPassHostActions {
  return {
    failInfrastructure(error) { fail(error); },
    bindGatekeeperNonPass() {},
  };
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

function withPassingGatekeeper(context: ExtensionContext): ExtensionContext {
  const faux = fauxProvider({ provider: "passing-gatekeeper", api: "passing-gatekeeper" });
  const model = faux.getModel();
  const responses = [
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "inspector" })),
    fauxAssistantMessage(fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] })),
  ];
  const provider = {
    ...faux.provider,
    stream() {
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected Gatekeeper provider request");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end(next));
      return stream;
    },
    streamSimple() { return this.stream(); },
  };
  return Object.assign(context, {
    cwd: process.cwd(), model,
    modelRegistry: scriptedGatekeeperModelRegistry(model, provider),
    thinkingLevel: "off",
  });
}

function workerCompletionGatekeeperHarness(options: {
  execute: (id: string, output: unknown, context: ExtensionContext) => Promise<unknown>;
  toolName: string;
  output: unknown;
  unusableSubmission?: Record<string, unknown>;
  officer?: "inspector" | "notary";
  officerUnusableSubmission?: Record<string, unknown>;
  passingRuns?: number;
}) {
  const {
    execute,
    toolName,
    output,
    unusableSubmission = { status: "not-a-release" } as Record<string, unknown>,
    officer = "inspector",
    officerUnusableSubmission = { status: "not-a-release", stage: "officer" } as Record<string, unknown>,
    passingRuns = 1,
  } = options;
  const officerTool = officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL;
  const faux = fauxProvider({ provider: "worker-gatekeeper", api: "worker-gatekeeper" });
  const model = faux.getModel();
  const responses: Array<AssistantMessage | Error> = [
    new Error("provider disconnected"),
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, unusableSubmission)),
    fauxAssistantMessage("not a receipt"),
    fauxAssistantMessage("still not a receipt"),
    fauxAssistantMessage("settled without a receipt"),
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer })),
    new Error("officer provider disconnected"),
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer })),
    fauxAssistantMessage(fauxToolCall(officerTool, officerUnusableSubmission)),
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer })),
    fauxAssistantMessage("officer did not submit a receipt"),
    fauxAssistantMessage("officer still did not submit a receipt"),
    fauxAssistantMessage("officer settled without a receipt"),
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer })),
    fauxAssistantMessage(fauxToolCall(officerTool, { status: "bounce", findings: ["add a focused regression"] })),
    ...Array.from({ length: passingRuns }, () => [
      fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer })),
      fauxAssistantMessage(fauxToolCall(officerTool, { status: "pass", findings: [] })),
    ]).flat(),
  ];
  let providerRequests = 0;
  const provider = {
    ...faux.provider,
    stream() {
      providerRequests += 1;
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected Gatekeeper provider request");
      if (next instanceof Error) throw next;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end(next));
      return stream;
    },
    streamSimple() { return this.stream(); },
  };
  return {
    context(id: string, toolName: string) {
      return Object.assign(toolCallContext([{ id, name: toolName }]), {
        cwd: process.cwd(), model,
        modelRegistry: scriptedGatekeeperModelRegistry(model, provider),
        thinkingLevel: "off",
      });
    },
    async assertRejectSequence() {
      const reject = async (id: string, check: (error: Error) => void) => {
        await assert.rejects(execute(id, output, this.context(id, toolName)), (error: unknown) => {
          assert.ok(error instanceof Error);
          check(error);
          return true;
        });
      };
      // Transport / unusable release are plain Error via failInfrastructure — not GatekeeperDecisionError.
      await reject("transport", (error) => assert.equal(error instanceof GatekeeperDecisionError, false));
      await reject("unusable-release", (error) => {
        assert.equal(error instanceof GatekeeperDecisionError, false);
        const typed = error as Error & { stage?: string; reason?: string; submission?: unknown };
        assert.equal(typed.stage, "gatekeeper");
        assert.ok(typeof typed.reason === "string" && typed.reason.length > 0);
        assert.deepEqual(typed.submission, unusableSubmission);
      });
      await reject("no-receipt", (error) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.equal(error.result.status, "no_receipt");
        if (error.result.status === "no_receipt") {
          assert.equal(error.result.stage, "gatekeeper");
          assert.equal(error.result.facts.acceptedReceipt, false);
          assert.equal(error.result.facts.sessionCompletion, "settled-without-accepted-receipt");
        }
      });
      await reject(`${officer}-transport`, (error) => assert.equal(error instanceof GatekeeperDecisionError, false));
      await reject(`${officer}-unusable-release`, (error) => {
        assert.equal(error instanceof GatekeeperDecisionError, false);
        const typed = error as Error & { stage?: string; reason?: string; submission?: unknown };
        assert.equal(typed.stage, officer);
        assert.ok(typeof typed.reason === "string" && typed.reason.length > 0);
        assert.deepEqual(typed.submission, officerUnusableSubmission);
      });
      await reject(`${officer}-no-receipt`, (error) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.equal(error.result.status, "no_receipt");
        if (error.result.status === "no_receipt") {
          assert.equal(error.result.stage, officer);
          assert.equal(error.result.facts.acceptedReceipt, false);
          assert.equal(error.result.facts.sessionCompletion, "settled-without-accepted-receipt");
        }
      });
      await reject("bounce", (error) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.equal(error.result.status, "bounce");
        if (error.result.status === "bounce") {
          assert.equal(error.result.officer, officer);
          assert.equal(error.result.disposition, "rewrite");
          assert.deepEqual(error.result.findings, ["add a focused regression"]);
          assert.deepEqual(error.result.submission, {
            status: "bounce",
            findings: ["add a focused regression"],
          });
        }
      });
    },
    get providerRequests() { return providerRequests; },
    get remainingResponses() { return responses.length; },
  };
}

function menxiaCatalogModel(provider: string, id: string) {
  return {
    api: "openai-responses" as const,
    provider,
    id,
    name: id,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

/**
 * Real submit-tool → requireGatekeeperPass → shared executor child model observation (#453).
 * Pass-only script; full non-pass matrix stays on workerCompletionGatekeeperHarness.
 */
function realEntryMenxiaModelHarness(options: {
  officer?: "inspector" | "notary";
  catalog?: ReadonlyArray<{ provider: string; id: string }>;
  authFailIds?: ReadonlySet<string>;
}) {
  const officer = options.officer ?? "inspector";
  const officerTool = officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL;
  const faux = fauxProvider({ provider: "worker-gatekeeper", api: "worker-gatekeeper" });
  const parentModel = faux.getModel();
  const catalog = new Map(
    (options.catalog ?? []).map((entry) => [
      `${entry.provider}/${entry.id}`,
      menxiaCatalogModel(entry.provider, entry.id),
    ]),
  );
  const authFailIds = options.authFailIds ?? new Set<string>();
  const seen: Array<{ provider: string; id: string }> = [];
  const responses = [
    fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer })),
    fauxAssistantMessage(fauxToolCall(officerTool, { status: "pass", findings: [] })),
  ];
  const provider = {
    ...faux.provider,
    stream(model: { provider: string; id: string }) {
      seen.push({ provider: model.provider, id: model.id });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected Gatekeeper provider request");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end(next));
      return stream;
    },
    streamSimple(model: { provider: string; id: string }) {
      return this.stream(model);
    },
  };
  return {
    parentModel,
    seen,
    context(id: string, toolName: string) {
      return Object.assign(toolCallContext([{ id, name: toolName }]), {
        cwd: process.cwd(),
        model: parentModel,
        modelRegistry: {
          // Override providers share the scripted stream so completion model is observable.
          getProvider() { return provider; },
          find(providerName: string, modelId: string) {
            return catalog.get(`${providerName}/${modelId}`);
          },
          async getProviderAuth() { return { auth: { apiKey: "test-key" } }; },
          async getApiKeyAndHeaders(candidate: { id?: string }) {
            if (candidate?.id !== undefined && authFailIds.has(candidate.id)) {
              return { ok: false, error: "override credentials missing" };
            }
            // Known providers (xai/openai-codex) require a key on ModelRuntime refresh.
            return { ok: true, apiKey: "test-key" };
          },
        },
        thinkingLevel: "off",
      });
    },
  };
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
    "ak-review-base",
    "ak-review-scope-keys",
    "ak-review-authority-refs",
    "ak-review-ticket-number",
    "ak-doctor-case",
    "ak-merger-input",
    "ak-notary-source-run",
    "ak-collector-repo",
    "ak-collector-pr",
    "ak-collector-request-manifest",
  ]));
  for (const [name, options] of harness.flags) {
    assert.equal((options as { type?: unknown }).type, "string", name);
  }
  assert.deepEqual(new Set(harness.handlers.keys()), new Set([
    "input",
    "before_agent_start",
    "session_start",
    "tool_result",
    "agent_end",
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
      assert.deepEqual(await readTypedHttp429Observation(runDirectory), {
        httpStatus: 429,
        provider: "openai-codex",
      });

      // Later non-429 in the same attempt supersedes — latest is authoritative.
      await handler(
        { type: "after_provider_response", status: 500, headers: {} },
        { model: { provider: "openai-codex" } },
      );
      assert.equal(await readTypedHttp429Observation(runDirectory), undefined);

      // Final qualifying 429 re-arms resume observation for this attempt.
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
        sessionFile: join(sessionDirectory, "session.jsonl"),
        admittedRequestPath,
      },
      { cause: "provider", diagnostic: "upstream declined this request" },
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

test("focused Judge controller registers output without narrowing host tools", async () => {
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
      auditSoulCompliance: async () => ({ status: "pass" }),
    },
    testHostActions(),
  );

  await runtime.activate();

  assert.deepEqual([...harness.tools.keys()], [JUDGE_OUTPUT_TOOL_NAME]);
  assert.deepEqual(harness.activeToolSets, []);
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
    },
    testHostActions(),
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
    testHostActions(),
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
            auditSoulCompliance: async () => ({ status: "pass", usage }),
          },
          testHostActions(),
        );
        await runtime.activate();
        return harness;
      },
      output: { judgeStatus: "converged", evidence: { checks: [{ name: "receipt", passed: true }] } },
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
          },
          testHostActions(),
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "completed", report: "done", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] },
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
          testHostActions(),
        );
        await runtime.activate();
        return harness;
      },
      output: { status: "planned", report: "plan" },
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
      tool.promptGuidelines === undefined || tool.promptGuidelines.length === 0,
      `${fixture.name} must not carry promptGuidelines instruction family`,
    );
    const result = await tool.execute(
      "receipt",
      fixture.output,
      undefined,
      undefined,
      fixture.role === "fixer" || fixture.role === "judge"
        ? withPassingGatekeeper(toolCallContext([{ id: "receipt", name: fixture.name }]))
        : toolCallContext([{ id: "receipt", name: fixture.name }]),
    );
    assert.deepEqual(result.details, fixture.output);
    assert.equal(result.terminate, true);
    assert.deepEqual(
      result.usage,
      fixture.role === "judge" ? usage : undefined,
    );
  }
});

test("production audit transcript preserves the assignment received by the judge", () => {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "user",
    content: "OWNER ASSIGNMENT: adjudicate issue 205",
    timestamp: Date.now(),
  });

  const transcript = productionTranscriptFromContext({
    sessionManager,
  } as unknown as ExtensionContext);

  assert.match(transcript, /OWNER ASSIGNMENT: adjudicate issue 205/);
});

test("judge role injects its soul and accepts a soul-compliant verdict", async () => {
  let auditCalls = 0;
  const { harness, tool } = await startJudge(async () => {
    auditCalls += 1;
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
    withPassingGatekeeper(toolCallContext([{ id: "call-1", arguments: verdict }])),
  );

  // Zero hand-delivery: auditor is invoked with context only (no projected materials).
  assert.equal(auditCalls, 1);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, verdict);
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
      withPassingGatekeeper(toolCallContext([{ id: "call-2", arguments: verdict }], () => {
        abortCalls += 1;
      })),
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
      withPassingGatekeeper(toolCallContext(
        [{ id: "audit-failure", arguments: verdict }],
        () => {
          abortCalls += 1;
        },
      )),
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
      recordPointer: () => "/fixture/navigator-record",
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
        tool.execute("failed-output", verdict, undefined, undefined, withPassingGatekeeper(toolCallContext([{ id: "failed-output", arguments: verdict }]))),
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
      assert.deepEqual(events, [], "infrastructure failure must not publish advice before drain");
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
      // Role infrastructure terminality is an affirmative no-advice outcome,
      // never a recommendation and never inferred from absence.
      assert.equal(events.length, 1, "infrastructure path emits one affirmative attendance fact");
      const attendance = events[0] as { disposition?: string } | undefined;
      assert.equal(attendance?.disposition, "no-advice");
      assert.notEqual(attendance?.disposition, "recommendation");
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
  let gatekeeperProviderRequests = 0;
  const result = await tool.execute(
    "coder",
    output,
    undefined,
    undefined,
    Object.assign(toolCallContext([{ id: "coder", name: CODER_OUTPUT_TOOL_NAME }]), {
      modelRegistry: { getProvider() { gatekeeperProviderRequests += 1; } },
    }),
  );
  assert.deepEqual(result.details, output);
  assert.equal(gatekeeperProviderRequests, 0);
});

test("coder apply unfinished without reason bounces then accepts reasoned resubmit; max two bounces then accept", async () => {
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
  const bare = {
    status: "unfinished" as const,
    report: "The first implementation is not fully settled.",
    remainingScope: "the unimplemented adapter branch",
  };
  const reasoned = {
    ...bare,
    reason: "prerequisite_missing: owner has not answered which adapter branch is in scope",
  };
  let gatekeeperProviderRequests = 0;
  const nonCompletedContext = (id: string) => Object.assign(
    toolCallContext([{ id, name: CODER_OUTPUT_TOOL_NAME }]),
    { modelRegistry: { getProvider() { gatekeeperProviderRequests += 1; } } },
  );
  // Positive: no reason → bounce → same-run reasoned resubmit accepted.
  await assert.rejects(
    tool.execute("unfinished-bare", bare, undefined, undefined, nonCompletedContext("unfinished-bare")),
    (error: unknown) =>
      error instanceof WorkerUnfinishedReasonReminderError &&
      error.code === "worker_unfinished_reason_reminder",
  );
  assert.deepEqual(
    (await tool.execute("unfinished-reasoned", reasoned, undefined, undefined, nonCompletedContext("unfinished-reasoned"))).details,
    reasoned,
  );
  const { extractCoderRoleOutcome } = await import("../../src/public-cli/settlement.ts");
  const projected = extractCoderRoleOutcome([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: CODER_OUTPUT_TOOL_NAME,
        isError: false,
        details: reasoned,
      },
    },
  ] as never);
  assert.equal(projected?.outcome.decisiveFacts.reason, reasoned.reason);
  assert.equal(projected?.outcome.decisiveFacts.remainingScope, reasoned.remainingScope);

  // Negative: continuous bare resubmits bounce at most twice, then accept (no loop).
  const harness2 = extensionHarness("coder", {
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
  })(harness2.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness2.handlers.get("session_start")?.({}, activationCtx(home));
  });
  const tool2 = harness2.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool2);
  await assert.rejects(
    tool2.execute("u1", bare, undefined, undefined, nonCompletedContext("u1")),
    (error: unknown) => error instanceof WorkerUnfinishedReasonReminderError,
  );
  await assert.rejects(
    tool2.execute("u2", bare, undefined, undefined, nonCompletedContext("u2")),
    (error: unknown) => error instanceof WorkerUnfinishedReasonReminderError,
  );
  assert.deepEqual(
    (await tool2.execute("u3", bare, undefined, undefined, nonCompletedContext("u3"))).details,
    bare,
  );
  assert.equal(gatekeeperProviderRequests, 0);
});

test("Gatekeeper non-pass projects structured details through role-runtime tool_result", async () => {
  // Real entry: judge output → requireGatekeeperPass binds via envelope hostActions → tool_result projects.
  const harness = extensionHarness("judge");
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "JUDGE LAW",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-gatekeeper-tool-result-" }, async ({ home }) => {
    const ctx = activationCtx(home);
    await harness.handlers.get("session_start")?.({}, ctx);
    const findings = ["add a focused regression"];
    const toolCallId = "judge-gk-bounce";
    const bounceSubmission = { status: "bounce", findings };
    const expected = {
      status: "bounce" as const,
      officer: "inspector" as const,
      disposition: "rewrite" as const,
      findings,
      submission: bounceSubmission,
    };
    const faux = fauxProvider({ provider: "gk-tool-result", api: "gk-tool-result" });
    const model = faux.getModel();
    const responses = [
      fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "inspector" })),
      fauxAssistantMessage(fauxToolCall(INSPECTOR_OUTPUT_TOOL, bounceSubmission)),
    ];
    const provider = {
      ...faux.provider,
      stream() {
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected Gatekeeper provider request");
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.end(next));
        return stream;
      },
      streamSimple() { return this.stream(); },
    };
    // Singleton check needs the tool-call leaf on sessionManager; do not clobber it with activationCtx.
    const gateContext = Object.assign(toolCallContext([{ id: toolCallId, name: JUDGE_OUTPUT_TOOL_NAME }]), {
      cwd: process.cwd(),
      model,
      modelRegistry: {
        getProvider(name: string) { return name === model.provider ? provider : undefined; },
        find(_providerName: string, _modelId: string) { return model; },
        async getProviderAuth() { return { auth: {} }; },
        async getApiKeyAndHeaders() { return { ok: true }; },
      },
      thinkingLevel: "off",
    });
    const tool = harness.tools.get(JUDGE_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    await assert.rejects(
      tool.execute(toolCallId, { judgeStatus: "converged" }, undefined, undefined, gateContext),
      (error: unknown) => {
        assert.ok(error instanceof GatekeeperDecisionError);
        assert.deepEqual(error.result, expected);
        return true;
      },
    );
    // Real parent seam: envelope tool_result projects bound structured non-pass onto session details.
    const projection = await harness.handlers.get("tool_result")?.({
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId,
      isError: true,
      content: [{ type: "text", text: "model-visible surface" }],
      details: {},
    }, ctx);
    assert.deepEqual(projection, { details: expected, isError: true });
    // Binding is single-consume; a second tool_result must not invent details.
    const second = await harness.handlers.get("tool_result")?.({
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId,
      isError: true,
      content: [{ type: "text", text: "model-visible surface" }],
      details: {},
    }, ctx);
    assert.equal(second, undefined);
  });
});

test("coder completed submissions traverse the real Gatekeeper provider gate until pass", async () => {
  const request = "Apply the approved plan.";
  const harness = extensionHarness(undefined, {
    "ak-coder-task": "/materials/approved.md",
    "ak-coder-phase": "apply",
  });
  const runtime = createCoderRoleRuntime(
    harness.pi as ExtensionAPI,
    {
      loadSoul: async () => "CODER LAW",
      loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
      loadCanonicalSkillBinding: async () => tddBinding(),
    },
    testHostActions(),
  );
  await runtime.activate();
  await harness.handlers.get("input")?.({ text: request }, {});
  await harness.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: expandedTdd(request) },
    { abort() {}, mode: "tui" },
  );
  const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
  assert.ok(tool);
  const completed = { status: "completed", report: "TDD and verification evidence" };
  const tracer = workerCompletionGatekeeperHarness({
    execute: (id, output, context) => tool.execute(id, output as typeof completed, undefined, undefined, context),
    toolName: CODER_OUTPUT_TOOL_NAME,
    output: completed,
  });
  await tracer.assertRejectSequence();
  const accepted = await tool.execute("accepted", completed, undefined, undefined, tracer.context("accepted", CODER_OUTPUT_TOOL_NAME));

  assert.equal(accepted.terminate, true);
  assert.equal(tracer.providerRequests, 17);
  assert.equal(tracer.remainingResponses, 0);
});

test("fixer completed-side submissions traverse the real Gatekeeper provider gate while non-completions skip it", async () => {
  const start = async (phase: "plan" | "apply") => {
    const harness = extensionHarness(undefined, {
      "ak-fix-packet": "/materials/fix.md",
      "ak-fixer-phase": phase,
    });
    const runtime = createFixerRoleRuntime(
      harness.pi as ExtensionAPI,
      { loadSoul: async () => "FIXER LAW", loadPacket: async () => emptyFixPacket },
      testHostActions(),
    );
    await runtime.activate();
    return harness.tools.get(FIXER_OUTPUT_TOOL_NAME)!;
  };
  const completed = {
    status: "completed" as const,
    report: "repair complete",
    classResults: [{ name: "Gate", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }],
  };
  const completedTool = await start("apply");
  const tracer = workerCompletionGatekeeperHarness({
    execute: (id, output, context) => completedTool.execute(id, output as typeof completed, undefined, undefined, context),
    toolName: FIXER_OUTPUT_TOOL_NAME,
    output: completed,
    passingRuns: 2,
  });
  const submissionContext = (id: string) => tracer.context(id, FIXER_OUTPUT_TOOL_NAME);
  await tracer.assertRejectSequence();
  assert.equal((await completedTool.execute("pass", completed, undefined, undefined, submissionContext("pass"))).terminate, true);

  const partial = {
    status: "partially_completed" as const,
    report: "mixed lawful settlement",
    classResults: [
      completed.classResults[0],
      { name: "Blocked", disposition: "refused" as const, remainingScope: "owner choice", blocker: { kind: "missing_prerequisite" as const, prerequisiteId: "owner.choice", reason: "owner choice missing" } },
    ],
  };
  const partialHarness = extensionHarness(undefined, { "ak-fix-packet": "/materials/fix.md", "ak-fixer-prerequisites": "/materials/prereqs.json", "ak-fixer-phase": "apply" });
  const partialRuntime = createFixerRoleRuntime(partialHarness.pi as ExtensionAPI, {
    loadSoul: async () => "FIXER LAW",
    loadPacket: async (path) => path.endsWith("prereqs.json") ? declaredFixPrerequisites : emptyFixPacket,
  }, testHostActions());
  await partialRuntime.activate();
  assert.equal((await partialHarness.tools.get(FIXER_OUTPUT_TOOL_NAME)!.execute("partial", partial, undefined, undefined, submissionContext("partial"))).terminate, true);

  const beforeSkipped = tracer.providerRequests;
  const planTool = await start("plan");
  await planTool.execute("planned", { status: "planned", report: "plan" }, undefined, undefined, submissionContext("planned"));
  await planTool.execute("plan-refused", { status: "refused", report: "blocked", remainingScope: "owner answer", blocker: { kind: "missing_prerequisite", prerequisiteId: "owner.choice", reason: "missing" } }, undefined, undefined, submissionContext("plan-refused"));
  const applyTool = await start("apply");
  await applyTool.execute("apply-refused", { status: "refused", report: "blocked", classResults: [{ name: "Blocked", disposition: "refused", remainingScope: "owner answer", blocker: { kind: "unconstitutional", authority: "ADR", conflict: "conflict" } }] }, undefined, undefined, submissionContext("apply-refused"));
  await applyTool.execute("unfinished", { status: "unfinished", report: "handover", remainingScope: "owner answer", reason: "prerequisite_missing: owner answer" }, undefined, undefined, submissionContext("unfinished"));
  assert.equal(tracer.providerRequests, beforeSkipped);
  assert.equal(tracer.providerRequests, 19);
  assert.equal(tracer.remainingResponses, 0);
});

test("judge submissions traverse the real Gatekeeper provider gate before auditor", async () => {
  let auditCalls = 0;
  const { tool } = await startJudge(async () => {
    auditCalls += 1;
    return { status: "pass" };
  });
  // Full 8-reject+pass matrix once; production does not branch on judgeStatus.
  const continueVerdict = {
    judgeStatus: "continue" as const,
    fix: { summary: "tighten the gate" },
    note: "ticket-review",
  };
  const tracer = workerCompletionGatekeeperHarness({
    execute: (id, output, context) => tool.execute(id, output, undefined, undefined, context),
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: continueVerdict,
    officer: "notary",
  });
  await tracer.assertRejectSequence();
  assert.equal(auditCalls, 0, "auditor must not start on Gatekeeper non-pass");
  const accepted = await tool.execute(
    "continue-pass",
    continueVerdict,
    undefined,
    undefined,
    tracer.context("continue-pass", JUDGE_OUTPUT_TOOL_NAME),
  );
  assert.equal(accepted.terminate, true);
  assert.deepEqual(accepted.details, continueVerdict);
  assert.equal(auditCalls, 1, "auditor runs only after Gatekeeper pass");
  assert.equal(tracer.providerRequests, 17);
  assert.equal(tracer.remainingResponses, 0);

  // Other judgeStatus: cheap same-gate assert — enters Gatekeeper; non-pass keeps auditor dark.
  const convergedVerdict = { judgeStatus: "converged" as const, note: "judgment" };
  const secondGate = workerCompletionGatekeeperHarness({
    execute: (id, output, context) => tool.execute(id, output, undefined, undefined, context),
    toolName: JUDGE_OUTPUT_TOOL_NAME,
    output: convergedVerdict,
    officer: "notary",
    passingRuns: 0,
  });
  await assert.rejects(
    tool.execute(
      "converged-gate",
      convergedVerdict,
      undefined,
      undefined,
      secondGate.context("converged-gate", JUDGE_OUTPUT_TOOL_NAME),
    ),
    (error: unknown) => {
      // First harness response is transport failure (plain Error via failInfrastructure).
      assert.ok(error instanceof Error);
      assert.equal(error instanceof GatekeeperDecisionError, false);
      return true;
    },
  );
  assert.equal(auditCalls, 1, "auditor must not start on Gatekeeper non-pass for other judgeStatus");
  assert.equal(secondGate.providerRequests, 1);
});

// #453: menxia model selection through real coder/fixer/judge submit tools.
test("#453 real coder/fixer/judge entries observe menxia model inheritance and overrides", async () => {
  const completedCoder = { status: "completed", report: "TDD and verification evidence" };
  const completedFixer = {
    status: "completed" as const,
    report: "repair complete",
    classResults: [{
      name: "Gate",
      disposition: "completed" as const,
      searchScope: "all",
      exceptions: [],
      commitSha: "a".repeat(40),
    }],
  };
  const continueVerdict = {
    judgeStatus: "continue" as const,
    fix: { summary: "tighten the gate" },
    note: "ticket-review",
  };

  const startCoder = async () => {
    const request = "Apply the approved plan.";
    const harness = extensionHarness(undefined, {
      "ak-coder-task": "/materials/approved.md",
      "ak-coder-phase": "apply",
    });
    const runtime = createCoderRoleRuntime(
      harness.pi as ExtensionAPI,
      {
        loadSoul: async () => "CODER LAW",
        loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
        loadCanonicalSkillBinding: async () => tddBinding(),
      },
      testHostActions(),
    );
    await runtime.activate();
    // Completed coder requires the canonical tdd expansion arming path.
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.({
      systemPrompt: "BASE",
      prompt: expandedTdd(request),
    }, { abort() {}, mode: "tui" });
    return harness.tools.get(CODER_OUTPUT_TOOL_NAME)!;
  };
  const startFixer = async () => {
    const harness = extensionHarness(undefined, {
      "ak-fix-packet": "/materials/fix.md",
      "ak-fixer-phase": "apply",
    });
    const runtime = createFixerRoleRuntime(
      harness.pi as ExtensionAPI,
      { loadSoul: async () => "FIXER LAW", loadPacket: async () => emptyFixPacket },
      testHostActions(),
    );
    await runtime.activate();
    return harness.tools.get(FIXER_OUTPUT_TOOL_NAME)!;
  };

  await withActivationHome({ prefix: "ak-453-menxia-model-" }, async ({ home }) => {
    // Unconfigured: all three real entries inherit the parent session model.
    for (const entry of [
      {
        name: "coder",
        officer: "inspector" as const,
        start: startCoder,
        output: completedCoder,
        toolName: CODER_OUTPUT_TOOL_NAME,
      },
      {
        name: "fixer",
        officer: "inspector" as const,
        start: startFixer,
        output: completedFixer,
        toolName: FIXER_OUTPUT_TOOL_NAME,
      },
      {
        name: "judge",
        officer: "notary" as const,
        start: async () => (await startJudge(async () => ({ status: "pass" as const }))).tool,
        output: continueVerdict,
        toolName: JUDGE_OUTPUT_TOOL_NAME,
      },
    ]) {
      const tool = await entry.start();
      const tracer = realEntryMenxiaModelHarness({ officer: entry.officer });
      const accepted = await tool.execute(
        `${entry.name}-inherit`,
        entry.output,
        undefined,
        undefined,
        tracer.context(`${entry.name}-inherit`, entry.toolName),
      );
      assert.equal(accepted.terminate, true, `${entry.name} must terminate after gate pass`);
      assert.deepEqual(
        tracer.seen,
        [
          { provider: tracer.parentModel.provider, id: tracer.parentModel.id },
          { provider: tracer.parentModel.provider, id: tracer.parentModel.id },
        ],
        `${entry.name} unconfigured menxia seats inherit parent model`,
      );
    }

    // gatekeeper-only: province + officer both use gatekeeper override.
    await savePublicCliConfig(
      setPersistentSeatConfig({ seats: {} }, "gatekeeper", {
        provider: "xai",
        model: "gate-only-model",
        thinking: "high",
      }),
      home,
    );
    for (const officer of ["inspector", "notary"] as const) {
      const tool = await startCoder();
      const tracer = realEntryMenxiaModelHarness({
        officer,
        catalog: [{ provider: "xai", id: "gate-only-model" }],
      });
      const accepted = await tool.execute(
        `gate-only-${officer}`,
        completedCoder,
        undefined,
        undefined,
        tracer.context(`gate-only-${officer}`, CODER_OUTPUT_TOOL_NAME),
      );
      assert.equal(accepted.terminate, true);
      assert.deepEqual(tracer.seen, [
        { provider: "xai", id: "gate-only-model" },
        { provider: "xai", id: "gate-only-model" },
      ]);
    }

    // Own officer overrides win; inspector/notary do not cross-wire.
    let config: PublicCliConfig = { seats: {} };
    config = setPersistentSeatConfig(config, "gatekeeper", {
      provider: "xai", model: "gate-model", thinking: "high",
    });
    config = setPersistentSeatConfig(config, "inspector", {
      provider: "openai-codex", model: "inspector-model", thinking: "medium",
    });
    config = setPersistentSeatConfig(config, "notary", {
      provider: "openai-codex", model: "notary-model", thinking: "high",
    });
    await savePublicCliConfig(config, home);
    const catalog = [
      { provider: "xai", id: "gate-model" },
      { provider: "openai-codex", id: "inspector-model" },
      { provider: "openai-codex", id: "notary-model" },
    ];
    {
      const tool = await startCoder();
      const tracer = realEntryMenxiaModelHarness({ officer: "inspector", catalog });
      assert.equal(
        (await tool.execute(
          "own-inspector",
          completedCoder,
          undefined,
          undefined,
          tracer.context("own-inspector", CODER_OUTPUT_TOOL_NAME),
        )).terminate,
        true,
      );
      assert.deepEqual(tracer.seen, [
        { provider: "xai", id: "gate-model" },
        { provider: "openai-codex", id: "inspector-model" },
      ]);
    }
    {
      const tool = await startCoder();
      const tracer = realEntryMenxiaModelHarness({ officer: "notary", catalog });
      assert.equal(
        (await tool.execute(
          "own-notary",
          completedCoder,
          undefined,
          undefined,
          tracer.context("own-notary", CODER_OUTPUT_TOOL_NAME),
        )).terminate,
        true,
      );
      assert.deepEqual(tracer.seen, [
        { provider: "xai", id: "gate-model" },
        { provider: "openai-codex", id: "notary-model" },
      ]);
    }

    // unset restores parent inheritance (gatekeeper cleared after officers).
    config = clearPersistentSeatConfig(config, "inspector");
    config = clearPersistentSeatConfig(config, "notary");
    config = clearPersistentSeatConfig(config, "gatekeeper");
    await savePublicCliConfig(config, home);
    {
      const tool = await startCoder();
      const tracer = realEntryMenxiaModelHarness({
        officer: "inspector",
        catalog, // leftover catalog must not apply without persistent seats
      });
      assert.equal(
        (await tool.execute(
          "unset-restore",
          completedCoder,
          undefined,
          undefined,
          tracer.context("unset-restore", CODER_OUTPUT_TOOL_NAME),
        )).terminate,
        true,
      );
      assert.deepEqual(tracer.seen, [
        { provider: tracer.parentModel.provider, id: tracer.parentModel.id },
        { provider: tracer.parentModel.provider, id: tracer.parentModel.id },
      ]);
    }

    // Explicit override auth failure is loud transport failure — no parent fallback.
    await savePublicCliConfig(
      setPersistentSeatConfig({ seats: {} }, "gatekeeper", {
        provider: "xai",
        model: "auth-fail-model",
      }),
      home,
    );
    {
      const tool = await startCoder();
      const tracer = realEntryMenxiaModelHarness({
        officer: "inspector",
        catalog: [{ provider: "xai", id: "auth-fail-model" }],
        authFailIds: new Set(["auth-fail-model"]),
      });
      await assert.rejects(
        tool.execute(
          "auth-fail",
          completedCoder,
          undefined,
          undefined,
          tracer.context("auth-fail", CODER_OUTPUT_TOOL_NAME),
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error instanceof GatekeeperDecisionError, false);
          assert.match(error.message, /authentication failed|override credentials missing/i);
          return true;
        },
      );
      assert.deepEqual(tracer.seen, [], "auth failure must not reach child completion");
    }
  });
});

test("coder apply binds completion to the immediately following canonical tdd expansion", async () => {
  // #319 Batch 3 (M1): lightweight expansion-binding API seam.
  // Publish-surface packaged Pi coverage stays in package-entrypoint (M1.4/M1.5).
  // Unarmed submission gate: completed does not need git baseline (gate ①).
  const request = "Apply the approved plan.";
  const completed = {
    status: "completed",
    report: "TDD evidence and self-check three are recorded here.",
  };
  const agentCtx = { abort() {}, mode: "tui" };

  const start = async () => {
    const harness = extensionHarness(undefined, {
      "ak-coder-task": "/materials/approved.md",
      "ak-coder-phase": "apply",
    });
    const faux = fauxProvider({ provider: "coder-binding-gatekeeper", api: "coder-binding-gatekeeper" });
    const model = faux.getModel();
    let providerRequests = 0;
    const provider = {
      ...faux.provider,
      stream() {
        providerRequests += 1;
        const response = providerRequests % 2 === 1
          ? fauxAssistantMessage(fauxToolCall(GATEKEEPER_OUTPUT_TOOL, { status: "dispatch", officer: "inspector" }))
          : fauxAssistantMessage(fauxToolCall(INSPECTOR_OUTPUT_TOOL, { status: "pass", findings: [] }));
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.end(response));
        return stream;
      },
      streamSimple() { return this.stream(); },
    };
    const runtime = createCoderRoleRuntime(
      harness.pi as ExtensionAPI,
      {
        loadSoul: async () => "CODER LAW",
        loadTask: async () => "APPROVED IMPLEMENTATION PLAN",
        loadCanonicalSkillBinding: async () => tddBinding(),
      },
      testHostActions(),
    );
    await runtime.activate();
    return Object.assign(harness, { model, provider, providerRequests: () => providerRequests });
  };
  const submitCompleted = async (
    harness: Awaited<ReturnType<typeof start>>,
    id: string,
  ) => {
    const tool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
    assert.ok(tool);
    return tool.execute(
      id,
      completed,
      undefined,
      undefined,
      Object.assign(toolCallContext([{ id, name: CODER_OUTPUT_TOOL_NAME }]), {
        cwd: process.cwd(),
        model: harness.model,
        modelRegistry: scriptedGatekeeperModelRegistry(harness.model, harness.provider, {
          matchProvider: false,
        }),
        thinkingLevel: "off",
      }),
    );
  };

  // M1.1 — completed binds to the immediately following canonical expansion.
  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.(
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
      await harness.handlers.get("input")?.(
        { text: "A later message must not reinvoke TDD." },
        {},
      ),
      { action: "continue" },
    );
    const promptResult = await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    const prompt = (promptResult as { systemPrompt: string }).systemPrompt;
    assert.match(prompt, /<coder_phase>\s*apply/);
    assert.doesNotMatch(prompt, /coder_quality_skill/);
    assert.deepEqual((await submitCompleted(harness, "accepted")).details, completed);
  }

  // M1.2 — one must-reject malformed expansion proves the completed-gate (law ③);
  // the full malformed spelling matrix lives in canonical-skill-binding tests.
  {
    const harness = await start();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request).replace(tddBody, "# Canonical TDD") },
      agentCtx,
    );
    await assert.rejects(
      submitCompleted(harness, "malformed-gate"),
      /completed requires the Matt tdd skill to be expanded/i,
    );
  }

  // M1.3 — later / non-immediate expansion must not authorize completed.
  {
    const harness = await start();
    await harness.handlers.get("input")?.({ text: request }, {});
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: "not the expansion" },
      agentCtx,
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    await assert.rejects(
      submitCompleted(harness, "later"),
      /completed requires the Matt tdd skill to be expanded/i,
    );
  }

  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.({
        text: `/skill:tdd ${request}`,
      }, {}),
      { action: "continue" },
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd(request) },
      agentCtx,
    );
    assert.deepEqual((await submitCompleted(harness, "prefixed")).details, completed);
  }

  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.({ text: "/skill:tdd" }, {}),
      { action: "continue" },
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd("") },
      agentCtx,
    );
    assert.deepEqual((await submitCompleted(harness, "bare-native")).details, completed);
  }

  // Prefix-collision transform binding (packaged seam owns real Pi expansion M1.5).
  {
    const harness = await start();
    assert.deepEqual(
      await harness.handlers.get("input")?.({ text: "/skill:tddfoo" }, {}),
      {
        action: "transform",
        text: "/skill:tdd /skill:tddfoo",
      },
    );
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: expandedTdd("/skill:tddfoo") },
      agentCtx,
    );
    assert.deepEqual((await submitCompleted(harness, "collision")).details, completed);
  }

  // Refusal remains a sole-final-call terminal without the TDD expansion obligation.
  {
    const harness = await start();
    const refused = {
      status: "refused",
      report: "The assignment contradicts its authority.",
    };
    const refusalTool = harness.tools.get(CODER_OUTPUT_TOOL_NAME);
    assert.ok(refusalTool);
    const requestsBeforeRefusal = harness.providerRequests();
    assert.deepEqual((await refusalTool.execute(
      "coder-refused",
      refused,
      undefined,
      undefined,
      toolCallContext([{ id: "coder-refused", name: CODER_OUTPUT_TOOL_NAME }]),
    )).details, refused);
    assert.equal(harness.providerRequests(), requestsBeforeRefusal);
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
    );
  }
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
    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "judge",
      loadFixerSoul: async () => "fixer",
      loadFixPacket: async () => row.packet,
      transcriptFromContext: () => "record",
      auditSoulCompliance: async () => ({ status: "pass" }),
    })(harness.pi as ExtensionAPI);
    await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
      await assert.rejects(Promise.resolve(harness.handlers.get("session_start")?.({}, activationCtx(home))), row.diagnostic);
    });
    assert.equal(harness.tools.has(FIXER_OUTPUT_TOOL_NAME), false);
    assert.equal(harness.handlers.has("before_agent_start"), true);
  }
});

test("undeclared prerequisite submissions are rejected; declared references accept without LLM audit", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "apply" });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer", loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n",
    transcriptFromContext: () => "record", auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
    const candidate = (prerequisiteId: string) => ({ status: "refused" as const, report: "Blocked.", classResults: [{ name: "Policy", disposition: "refused" as const, remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId, evidence: "Choice absent." } }] });
    await assert.rejects(tool.execute("bad", candidate("other"), undefined, undefined, toolCallContext([{ id: "bad", name: FIXER_OUTPUT_TOOL_NAME }])), /Fixer output/);
    const accepted = await tool.execute("good", candidate("owner.choice"), undefined, undefined, toolCallContext([{ id: "good", name: FIXER_OUTPUT_TOOL_NAME }]));
    assert.equal(Object.isFrozen(accepted.details), true);
    assert.deepEqual(accepted.details, candidate("owner.choice"));

    const partial = {
      status: "partially_completed" as const,
      report: "Mixed.",
      classResults: [
        { name: "Done", disposition: "completed" as const, searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
        { name: "Policy", disposition: "refused" as const, remainingScope: "policy", blocker: { cause: "prerequisite_unmet" as const, prerequisiteId: "owner.choice", evidence: "Choice absent." } },
      ],
    };
    await assert.rejects(tool.execute("partial", partial, undefined, undefined, toolCallContext([{ id: "partial", name: FIXER_OUTPUT_TOOL_NAME }])), /未观察到 commit/);
    const second = await tool.execute("partial2", partial, undefined, undefined, withPassingGatekeeper(toolCallContext([{ id: "partial2", name: FIXER_OUTPUT_TOOL_NAME }])));
    assert.deepEqual(second.details, partial);

    const sharedCommit = "shared-commit";
    const classA = { name: "Reviewer diagnostics", disposition: "completed" as const, searchScope: "reviewer admission and dispatch", exceptions: [], commitSha: sharedCommit };
    const classB = { name: "Fixer projection", disposition: "completed" as const, searchScope: "fixer output branches", exceptions: [], commitSha: sharedCommit };
    const shared = await tool.execute("shared", { status: "completed", report: "Both classes settled.", classResults: [classA, classB] }, undefined, undefined, withPassingGatekeeper(toolCallContext([{ id: "shared", name: FIXER_OUTPUT_TOOL_NAME }])));
    assert.equal(shared.terminate, true);
    assert.deepEqual(shared.details.classResults, [classA, classB]);
  });
});
test("declared plan refusal accepts without LLM audit", async () => {
  const harness = extensionHarness("fixer", { "ak-fix-packet": "/packet.md", "ak-fixer-prerequisites": "/prerequisites.json", "ak-fixer-phase": "plan" });
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge", loadFixerSoul: async () => "fixer",
    loadFixPacket: async (path) => path.endsWith("prerequisites.json") ? declaredFixPrerequisites : "# Repair prose\n",
    transcriptFromContext: () => "plan-record", auditSoulCompliance: async () => ({ status: "pass" }),
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
    const tool = harness.tools.get(FIXER_OUTPUT_TOOL_NAME); assert.ok(tool);
    const candidate = { status: "refused", report: "Blocked.", remainingScope: "policy", blocker: { cause: "prerequisite_unmet", prerequisiteId: "owner.choice", evidence: "Choice absent." } };
    const accepted = await tool.execute("plan-refused", candidate, undefined, undefined, toolCallContext([{ id: "plan-refused", name: FIXER_OUTPUT_TOOL_NAME }]));
    assert.deepEqual(accepted.details, candidate);
    assert.equal(accepted.terminate, true);
  });
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
  })(harness.pi as ExtensionAPI);
  await withActivationHome({ prefix: "ak-judge-role-" }, async ({ home }) => {
    await harness.handlers.get("session_start")?.({}, activationCtx(home));
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
      );
    }

    await assert.rejects(
      tool.execute("fixer", output, undefined, undefined, toolCallContext([{ id: "fixer", name: FIXER_OUTPUT_TOOL_NAME }])),
      /未观察到 commit/,
    );
    const accepted = await tool.execute(
      "fixer",
      output,
      undefined,
      undefined,
      withPassingGatekeeper(toolCallContext([{ id: "fixer", name: FIXER_OUTPUT_TOOL_NAME }])),
    );
    assert.deepEqual(accepted.details, output);
    assert.equal(accepted.terminate, true);
  });
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
    );
  }
  assert.equal(auditCalls, 0);
  const accepted = await tool.execute(
    "judge",
    verdict,
    undefined,
    undefined,
    withPassingGatekeeper(toolCallContext([{ id: "judge", name: JUDGE_OUTPUT_TOOL_NAME, arguments: verdict }])),
  );
  assert.deepEqual(accepted.details, verdict);
  assert.equal(accepted.terminate, true);
});

test(
  "accepted role terminal races production 10s Navigator grace through role-runtime to Terminal",
  { timeout: 30_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(NAVIGATOR_POST_ROLE_GRACE_MS, 10_000);

    const routePlaybookCause = "ROUTEBOOK_FAILED_BEFORE_HELD_PROMPT";
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
            modelSettingPath,
            loadSoul: async () => "route law",
            loadRoutePlaybook: async () => {
              throw new Error(routePlaybookCause);
            },
            loadRoleHelp: async (role) => `Usage: pi --ak-role ${role} --help`,
            createSession: async () => ({
              async prompt() {
                preparationStarted();
                await preparationGate;
              },
              appendEntry() {},
              entries: () => [],
              recordPointer: () => "/fixture/navigator-record",
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
        const details = sentMessages[0]?.details as NavigatorEvent;
        assert.equal(details.disposition, "unavailable");
        assert.equal(details.invocationId, "post-role-grace-timeout");
        assert.equal(typeof details.unavailableReason, "string");
        assert.ok(String(details.unavailableReason).length > 0);
        assert.equal(details.unavailableSource, "unknown");
        assert.equal(details.unavailableCause, "unknown");
        assert.equal(details.routePlaybookReadFailure, routePlaybookCause);

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
        const terminalInvocationId = "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b";
        const navigator = extractNavigatorFact([
          {
            type: "custom",
            customType: NAVIGATOR_INVOCATION_ENTRY,
            data: {
              invocationId: terminalInvocationId,
              role: "judge",
              phase: null,
              subjectKey: details.subjectKey,
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { judgeStatus: "converged" },
            },
          },
          {
            type: "custom_message",
            customType: "ak-navigator-attendance",
            message: { details: { ...details, invocationId: terminalInvocationId } },
          },
        ] as never);
        assert.equal(navigator.disposition, "unavailable");
        if (navigator.disposition === "unavailable") {
          assert.equal(navigator.source, "unknown");
          assert.equal(typeof navigator.reason, "string");
          assert.ok(navigator.reason.length > 0);
          assert.equal(navigator.advisoryDiagnostic, routePlaybookCause);
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

// #420 整改移档（自 package-entrypoint-packaged-workers.integration.test.ts）：
// 纯进程内模块逻辑（Source-tree imports，无任何装包边界），性质属快档。
// 契约断言一字不减：revise→errored / pass→terminate / escalate 全矩阵在此。
test("role outputs run nested audits through pass, revise, and escalation", async () => {
  // Source-tree imports: cold-install boundary is owned by neighbouring install tests;
  // this carrier owns revise→errored / pass→terminate / escalate per role output tool.
  const root = packageRoot;
  const importSrc = (rel: string) => import(resolve(root, rel));
  const nestedRunDir = await mkdtemp(join(tmpdir(), "ak-nested-audit-run-"));
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = nestedRunDir;
  try {
  {
      const [judge, reviewer, doctor, judgeRole, workerRole, reviewerRole, doctorRole, terminating] = await Promise.all([
        importSrc("src/judge-auditor.ts"),
        importSrc("src/reviewer-auditor.ts"),
        importSrc("src/doctor-auditor.ts"),
        importSrc("src/judge-role.ts"),
        importSrc("src/worker-role.ts"),
        importSrc("src/reviewer-role.ts"),
        importSrc("src/doctor-role.ts"),
        importSrc("src/package-contracts/terminating-tools.ts"),
      ]);

      const patient = {
        version: 1,
        identity: { issueNumber: 58, runsPath: ".ak/work/issues/58/runs" },
        evidence: [],
        cost: { invocations: { total: 0, sources: [] }, bytes: 0 },
      };
      const skill = "canonical review skill";
      const escalation = {
        status: "escalate" as const,
        violations: [],
        conflicts: ["Soul conflicts with controlling authority"],
        decisionGate: {
          question: "Which authority governs this submission?",
          options: ["Soul", "Controlling authority"],
        },
      };
      const revise = {
        status: "revise" as const,
        violations: ["one concrete procedural violation"],
        conflicts: [],
        decisionGate: null,
      };
      const pass = {
        status: "pass" as const,
        violations: [],
        conflicts: [],
        decisionGate: null,
      };
      const outputs = {
        judge: { judgeStatus: "converged" },
        fixer: { status: "completed", report: "done", classResults: [
          { name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
          { name: "Audit", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) },
        ] },
        reviewer: { status: "refused", diagnostic: "no accepted dispatch" },
        doctor: { status: "refused", reason: "missing", missingEvidence: [{ need: "case evidence", targetKeys: ["case"] }] },
      } as const;
      const toolNames = {
        judge: judge.JUDGE_AUDIT_TOOL_NAME,
        reviewer: reviewer.REVIEWER_AUDIT_TOOL_NAME,
        doctor: doctor.DOCTOR_AUDIT_TOOL_NAME,
      } as const;
      const acceptedNames = {
        judge: "ak_judge_output",
        fixer: "ak_fixer_output",
        reviewer: "ak_reviewer_output",
        doctor: "ak_doctor_output",
      } as const;

      const makeHarness = (flags: Record<string, string> = {}) => {
        const tools = new Map<string, any>();
        const handlers = new Map<string, any>();
        const hostTools = ["read", "write", "grep", "find", "bash"];
        let activeTools: string[] = [...hostTools];
        const pi = {
          registerFlag() {},
          getFlag(name: string) { return flags[name]; },
          registerTool(tool: any) { tools.set(tool.name, tool); },
          getAllTools() { return [...hostTools, ...tools.keys()].map((name) => ({ name })); },
          setActiveTools(names: string[]) { activeTools = [...names]; },
          getActiveTools() { return activeTools; },
          on(name: string, handler: any) { handlers.set(name, handler); },
        };
        return { pi, tools, handlers, activeTools: () => [...activeTools] };
      };
      const outputContext = (name: string, id: string, arguments_: Record<string, unknown> = {}) => {
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendMessage({ role: "user", content: "assignment", timestamp: Date.now() });
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "toolCall", id, name, arguments: arguments_ }],
          api: "openai-responses",
          provider: "installed-role",
          model: "installed-role",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
        return {
          sessionManager,
          model: { api: "openai-responses", provider: "installed-auditor", id: "installed-auditor" },
          modelRegistry: {
            async getProviderAuth() { return { auth: { apiKey: "offline" } }; },
            async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
          },
        } as any;
      };

      const createRole = (role: keyof typeof outputs, decision: typeof pass | typeof revise | typeof escalation) => {
        const harness = role === "fixer"
          ? makeHarness({ "ak-fix-packet": "/packet", "ak-fixer-phase": "apply" })
          : role === "reviewer"
            ? makeHarness({ "ak-review-base": "review-base" })
            : role === "doctor"
              ? makeHarness({ "ak-doctor-case": "/case" })
              : makeHarness();
        let auditCalls = 0;
        let selectedDecision = decision;
        const complete = async (_model: unknown, _request: Context) => {
          auditCalls += 1;
          const auditTool = toolNames[role as Exclude<typeof role, "fixer">];
          return fauxAssistantMessage(fauxToolCall(auditTool, selectedDecision), { stopReason: "toolUse" });
        };
// Judge/reviewer/doctor: zero-arg materials (#233). Fixer LLM auditor retired (#242).
        const auditCompliance = (options: any) => {
          if (role === "judge") return judge.createPiJudgeAuditor(complete)(options);
          if (role === "reviewer") return reviewer.createPiReviewerAuditor(complete)(options);
          return doctor.createPiDoctorAuditor(complete)(options);
        };
        let runtime: any;
        if (role === "judge") {
          runtime = judgeRole.createJudgeRoleRuntime(harness.pi, {
            loadSoul: async () => "judge law",
            auditSoulCompliance: auditCompliance,
          }, testHostActions());
        } else if (role === "fixer") {
          runtime = workerRole.createFixerRoleRuntime(harness.pi, {
            loadSoul: async () => "fixer law",
            loadPacket: async () => "repair packet",
          }, testHostActions());
        } else if (role === "doctor") {
          runtime = doctorRole.createDoctorRoleRuntime(harness.pi, {
            loadSoul: async () => "doctor law",
            loadCase: async () => patient,
            auditCompliance,
          }, testHostActions());
        } else {
          const pin = { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "target", refs: {} };
          runtime = reviewerRole.createReviewerRoleRuntime(harness.pi, {
            loadSoul: async () => "reviewer law",
            loadCanonicalSkillBinding: async () => ({
              name: "code-review",
              snapshot: { raw: skill, path: "/skill", baseDir: "/", body: skill, snapshotIdentity: Object.freeze({ text: skill }) },
              invocation: (request: string) => request,
              captureExpansion: () => ({ name: "code-review" as const, location: "/skill", content: skill }),
            }),
            createPinnedGitReader: async () => ({
              pin,
              snapshot: async () => pin,
              resolve: async () => "base",
              range: async () => ({ base: "base", target: "target", diffCommand: "git diff base...target", diffSha256: "a".repeat(64), commits: ["target"] }),
              featureTokens: async () => Object.freeze([]),
              listSpecCandidatePaths: async () => Object.freeze([]),
              originRepository: async () => undefined,
              commitMessagesNewestFirst: async () => Object.freeze([]),
              readPinnedText: async () => undefined,
            }),
            runDispatch: async () => { throw new Error("dispatch must not run for refusal"); },
            auditCompliance,
          }, testHostActions());
        }
        return {
          harness,
          runtime,
          setDecision(next: typeof pass | typeof revise | typeof escalation) { selectedDecision = next; },
          get auditCalls() { return auditCalls; },
        };
      };

      for (const role of ["judge", "fixer", "reviewer", "doctor"] as const) {
        const toolName = role === "judge" ? judgeRole.JUDGE_OUTPUT_TOOL_NAME : role === "fixer" ? workerRole.FIXER_OUTPUT_TOOL_NAME : role === "reviewer" ? reviewerRole.REVIEWER_OUTPUT_TOOL_NAME : doctorRole.DOCTOR_OUTPUT_TOOL_NAME;
        if (role === "fixer") {
          // #242: Fixer LLM auditor retired — accept on schema validate only, no audit leg.
          const plain = createRole(role, pass);
          await plain.runtime.activate();
          const tool = plain.harness.tools.get(toolName);
          assert.ok(tool);
          const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, withPassingGatekeeper(outputContext(tool.name, `${role}-pass`)));
          assert.equal(accepted.terminate, true);
          assert.deepEqual(accepted.details, outputs[role]);
          assert.equal(plain.auditCalls, 0);
          continue;
        }
        const retriable = createRole(role, revise);
        if (role === "reviewer") {
          await retriable.runtime.activate(undefined, { baseRevision: "review-base" });
        } else {
          await retriable.runtime.activate();
        }
        if (role === "reviewer") {
          assert.deepEqual(
            retriable.harness.activeTools(),
            ["read", "write", "grep", "find", "bash"],
            "Reviewer activation must preserve Pi's evidence tool surface",
          );
        }
        const tool = retriable.harness.tools.get(toolName);
        assert.ok(tool);
        const submissionContext = (id: string) => {
          const bare = outputContext(tool.name, id, outputs[role] as Record<string, unknown>);
          return role === "judge" ? withPassingGatekeeper(bare) : bare;
        };
        await assert.rejects(tool.execute(`${role}-revise`, outputs[role], undefined, undefined, submissionContext(`${role}-revise`)), /violation|violates its|closed contract/);
        retriable.setDecision(pass);
        const accepted = await tool.execute(`${role}-pass`, outputs[role], undefined, undefined, submissionContext(`${role}-pass`));
        assert.equal(accepted.terminate, true);
        if (role === "judge") assert.equal(accepted.details.judgeStatus, outputs[role].judgeStatus);
        else assert.equal(accepted.details.status, outputs[role].status);
        if (role !== "reviewer") assert.deepEqual(accepted.details, outputs[role]);
        assert.equal(retriable.auditCalls, 2, `${role} must audit the rejected submission and its resubmission`);

        const escalated = createRole(role, escalation);
        if (role === "reviewer") {
          await escalated.runtime.activate(undefined, { baseRevision: "review-base" });
        } else {
          await escalated.runtime.activate();
        }
        const escalationTool = escalated.harness.tools.get(tool.name);
        const result = await escalationTool.execute(`${role}-escalate`, outputs[role], undefined, undefined, submissionContext(`${role}-escalate`));
        assert.equal(result.terminate, true);
        // Escalation face carries audit kind/conflicts/gate AND the seat's
        // already-delivered fields (ADR 0055). Old "exactly three keys" deepEqual
        // encoded the destruction this ticket forbids.
        assert.equal(result.details.kind, "audit_escalation");
        assert.deepEqual(result.details.conflicts, escalation.conflicts);
        assert.deepEqual(result.details.auditDecisionGate, escalation.decisionGate);
        for (const [key, value] of Object.entries(outputs[role])) {
          assert.deepEqual(
            (result.details as Record<string, unknown>)[key],
            value,
            `${role} delivered field ${key} must ride the escalate face`,
          );
        }
        assert.equal(isAuditEscalationResult(result.details), true);
        assert.throws(
          () => terminating.validateAcceptedDetails(acceptedNames[role], result.details),
          (error: unknown) => error instanceof Error && error.name === "AcceptedDetailsContractError",
        );
        assert.equal(escalated.auditCalls, 1);
      }
  }
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    await rm(nestedRunDir, { recursive: true, force: true });
  }
});
