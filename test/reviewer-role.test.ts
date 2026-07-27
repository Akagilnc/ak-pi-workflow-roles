import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  AGENT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type ReviewerAuditInput,
} from "../src/role-runtime.ts";
import type { CanonicalReviewerSkill } from "../src/reviewer-skill.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

const canonicalSkill: CanonicalReviewerSkill = {
  raw: "---\nname: code-review\ndescription: review\n---\n\n# Canonical review",
  path: "/home/test/.agents/skills/code-review/SKILL.md",
  baseDir: "/home/test/.agents/skills/code-review",
  body: "# Canonical review",
};

function harness() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, any>();
  const activeToolSets: string[][] = [];
  const all = new Set(["read", "grep", "find", "ls", "bash", "write", "edit", "other"]);
  const flags: Record<string, string> = {
    "ak-role": "reviewer",
    "ak-review-task": "/task.md",
  };
  const pi = {
    registerFlag() {},
    getFlag(name: string) { return flags[name]; },
    on(name: string, fn: (event: any, ctx: any) => any) { handlers.set(name, fn); },
    registerTool(tool: any) { tools.set(tool.name, tool); all.add(tool.name); },
    getAllTools() { return [...all].map((name) => ({ name })); },
    setActiveTools(names: string[]) { activeToolSets.push(names); },
  };
  return { pi, handlers, tools, activeToolSets };
}

function context(
  id: string,
  name = REVIEWER_OUTPUT_TOOL_NAME,
  calls: Array<{ id: string; name: string }> = [{ id, name }],
): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: {},
    })),
    api: "openai-responses",
    provider: "test",
    model: "reviewer",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  sessionManager.appendMessage(message);
  return {
    sessionManager,
    abort() {},
    mode: "tui",
  } as unknown as ExtensionContext;
}

function extension(overrides: Record<string, unknown> = {}) {
  const h = harness();
  const audits: ReviewerAuditInput[] = [];
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "judge",
    loadReviewerSoul: async () => "REVIEWER LAW",
    loadReviewerTask: async () => "# Opaque request\nReview fixed point main.",
    loadCanonicalReviewerSkill: async () => canonicalSkill,
    runReviewerAgent: async () => ({
      report: "axis report",
      usage,
      workspaceDisposition: "deleted",
    }),
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    auditReviewerCompliance: async (input: ReviewerAuditInput) => {
      audits.push(input);
      return { status: "pass" as const };
    },
    ...overrides,
  })(h.pi as unknown as ExtensionAPI);
  return { ...h, audits };
}

async function establishExpansion(handlers: Map<string, (event: any, ctx: any) => any>) {
  const original = "Review the requested fixed point.";
  assert.deepEqual(await handlers.get("input")?.({ text: original }, {}), {
    action: "transform",
    text: `/skill:code-review ${original}`,
  });
  await handlers.get("before_agent_start")?.({
    systemPrompt: "BASE",
    prompt: `<skill name="code-review" location="${canonicalSkill.path}">\nReferences are relative to ${canonicalSkill.baseDir}.\n\n${canonicalSkill.body}\n</skill>\n\n${original}`,
  }, { abort() {}, mode: "tui" });
}

test("reviewer loads opaque input and exposes only its exact seven-tool surface", async () => {
  const { handlers, tools, activeToolSets } = extension();
  await handlers.get("session_start")?.({}, {});

  assert.deepEqual(activeToolSets, [[
    "read", "grep", "find", "ls", "bash", AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME,
  ]]);
  const prompt = await handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: "not the transformed first prompt" },
    {},
  );
  assert.match(prompt.systemPrompt, /REVIEWER LAW/);
  assert.match(prompt.systemPrompt, /# Opaque request/);
  assert.ok(tools.has(AGENT_TOOL_NAME));
  assert.ok(tools.has(REVIEWER_OUTPUT_TOOL_NAME));
  assert.equal(tools.get(AGENT_TOOL_NAME).executionMode, "parallel");
  assert.deepEqual(Object.keys(tools.get(AGENT_TOOL_NAME).parameters.properties), [
    "subagent_type", "description", "prompt",
  ]);
  assert.equal(tools.get(AGENT_TOOL_NAME).parameters.additionalProperties, false);
});

test("completed requires exact native Skill provenance and successful Agent evidence", async () => {
  const { handlers, tools, audits } = extension();
  await handlers.get("session_start")?.({}, {});
  const output = { status: "completed", report: "## Standards\nDone." };
  const outputTool = tools.get(REVIEWER_OUTPUT_TOOL_NAME);

  await assert.rejects(
    outputTool.execute("no-skill", output, undefined, undefined, context("no-skill")),
    /native code-review skill expansion/i,
  );

  await establishExpansion(handlers);
  await assert.rejects(
    outputTool.execute("no-agent", output, undefined, undefined, context("no-agent")),
    /successful Agent call/i,
  );

  const agent = tools.get(AGENT_TOOL_NAME);
  const axisContext = context("axis-1", AGENT_TOOL_NAME);
  const agentResult = await agent.execute(
    "axis-1",
    { subagent_type: "general-purpose", description: "Standards", prompt: "Inspect the pinned diff." },
    undefined,
    undefined,
    axisContext,
  );
  assert.equal(agentResult.content[0].text, "axis report");
  assert.deepEqual(agentResult.usage, usage);

  const accepted = await outputTool.execute(
    "done",
    output,
    undefined,
    undefined,
    context("done"),
  );
  assert.equal(accepted.terminate, true);
  assert.deepEqual(accepted.details, output);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.candidate.status, "completed");
  assert.equal(audits[0]?.record.agentAttempts.length, 1);
  assert.deepEqual(audits[0]?.record.agentInvocationBatches, [{
    assistantSessionEntryId: axisContext.sessionManager.getLeafEntry()?.id,
    executionMode: "parallel",
    agentToolCallIds: ["axis-1"],
  }]);
});

test("Agent calls preserve same-message batches and isolate separate assistant entries", async () => {
  const { handlers, tools, audits } = extension();
  await handlers.get("session_start")?.({}, {});
  await establishExpansion(handlers);
  const agent = tools.get(AGENT_TOOL_NAME);
  const shared = context("axis-a", AGENT_TOOL_NAME, [
    { id: "axis-a", name: AGENT_TOOL_NAME },
    { id: "axis-b", name: AGENT_TOOL_NAME },
  ]);
  const sharedEntryId = shared.sessionManager.getLeafEntry()?.id;
  await agent.execute(
    "axis-a",
    { subagent_type: "general-purpose", description: "A", prompt: "A" },
    undefined,
    undefined,
    shared,
  );
  await agent.execute(
    "axis-b",
    { subagent_type: "general-purpose", description: "B", prompt: "B" },
    undefined,
    undefined,
    shared,
  );
  const later = context("later", AGENT_TOOL_NAME);
  const laterEntryId = later.sessionManager.getLeafEntry()?.id;
  await agent.execute(
    "later",
    { subagent_type: "general-purpose", description: "Later", prompt: "Later" },
    undefined,
    undefined,
    later,
  );
  await tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
    "done",
    { status: "completed", report: "review" },
    undefined,
    undefined,
    context("done"),
  );

  assert.deepEqual(audits[0]?.record.agentInvocationBatches, [
    {
      assistantSessionEntryId: sharedEntryId,
      executionMode: "parallel",
      agentToolCallIds: ["axis-a", "axis-b"],
    },
    {
      assistantSessionEntryId: laterEntryId,
      executionMode: "parallel",
      agentToolCallIds: ["later"],
    },
  ]);
});

test("duplicate and conflicting Agent batch provenance fail before child start or receipt", async () => {
  for (const scenario of ["duplicate", "conflicting"] as const) {
    let childStarts = 0;
    let audits = 0;
    const fixture = extension({
      runReviewerAgent: async () => {
        childStarts += 1;
        return { report: "impossible", workspaceDisposition: "deleted" };
      },
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    const ctx = context("boundary", AGENT_TOOL_NAME,
      scenario === "duplicate"
        ? [
            { id: "boundary", name: AGENT_TOOL_NAME },
            { id: "boundary", name: AGENT_TOOL_NAME },
          ]
        : [{ id: "boundary", name: AGENT_TOOL_NAME }],
    );
    let aborts = 0;
    (ctx as any).abort = () => { aborts += 1; };
    let recorded: any;

    if (scenario === "conflicting") {
      await fixture.handlers.get("tool_execution_start")?.({
        toolCallId: "boundary",
        toolName: AGENT_TOOL_NAME,
        args: { description: "first", prompt: "first" },
      }, ctx);
      const leaf = ctx.sessionManager.getLeafEntry();
      assert.ok(leaf?.type === "message" && leaf.message.role === "assistant");
      leaf.message.content.push({
        type: "toolCall",
        id: "later-sibling",
        name: AGENT_TOOL_NAME,
        arguments: {},
      });
    }

    await assert.rejects(
      async () => {
        try {
          await fixture.handlers.get("tool_execution_start")?.({
            toolCallId: "boundary",
            toolName: AGENT_TOOL_NAME,
            args: { description: scenario, prompt: scenario },
          }, ctx);
        } catch (error) {
          recorded = (error as { reviewerAgentAttempt?: unknown })
            .reviewerAgentAttempt;
          throw error;
        }
      },
      scenario === "duplicate"
        ? /does not occur exactly once|not unique/
        : /conflicting batch evidence/,
    );
    assert.equal(aborts, 1);
    assert.equal(childStarts, 0);
    assert.equal(audits, 0);
    assert.equal(recorded.id, "boundary");
    assert.equal(recorded.status, "failed");
    assert.match(recorded.diagnostics, scenario === "duplicate"
      ? /does not occur exactly once|not unique/
      : /conflicting batch evidence/);

    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "done",
        { status: "completed", report: "must not be accepted" },
        undefined,
        undefined,
        context("done"),
      ),
      /infrastructure previously failed/,
    );
    assert.equal(audits, 0);
  }
});

test("missing or malformed Agent leaf provenance aborts before child start", async () => {
  for (const scenario of ["missing", "malformed"] as const) {
    let childStarts = 0;
    let audits = 0;
    const fixture = extension({
      runReviewerAgent: async () => {
        childStarts += 1;
        return { report: "impossible", workspaceDisposition: "deleted" };
      },
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    const sessionManager = SessionManager.inMemory();
    if (scenario === "malformed") {
      sessionManager.appendMessage({
        role: "user",
        content: "not an assistant tool-call message",
        timestamp: Date.now(),
      });
    }
    let aborts = 0;
    const ctx = {
      sessionManager,
      abort() { aborts += 1; },
      mode: "tui",
    } as unknown as ExtensionContext;
    let recorded: unknown;
    await assert.rejects(
      async () => {
        try {
          await fixture.tools.get(AGENT_TOOL_NAME).execute(
            `bad-${scenario}`,
            {
              subagent_type: "general-purpose",
              description: scenario,
              prompt: scenario,
            },
            undefined,
            undefined,
            ctx,
          );
        } catch (error) {
          recorded = (error as { reviewerAgentAttempt?: unknown })
            .reviewerAgentAttempt;
          throw error;
        }
      },
      /persisted session leaf is not an assistant message/,
    );
    assert.equal(aborts, 1);
    assert.equal(childStarts, 0);
    assert.equal(audits, 0);
    assert.deepEqual(recorded, {
      id: `bad-${scenario}`,
      description: scenario,
      prompt: scenario,
      status: "failed",
      diagnostics: "Reviewer Agent invocation provenance failed: the persisted session leaf is not an assistant message",
    });
  }
});

test("refused can be audited before Skill or Agent and revise is resubmittable", async () => {
  let calls = 0;
  const { handlers, tools } = extension({
    auditReviewerCompliance: async () => {
      calls += 1;
      return calls === 1
        ? { status: "revise" as const, violations: ["Refusal is not evidenced"] }
        : { status: "pass" as const };
    },
  });
  await handlers.get("session_start")?.({}, {});
  const tool = tools.get(REVIEWER_OUTPUT_TOOL_NAME);
  const refusal = { status: "refused", report: "Cannot establish the requested target." };

  await assert.rejects(
    tool.execute("first", refusal, undefined, undefined, context("first")),
    /Refusal is not evidenced/,
  );
  const accepted = await tool.execute("second", refusal, undefined, undefined, context("second"));
  assert.equal(accepted.terminate, true);
  assert.equal(calls, 2);
});

test("Reviewer cleanup failure is fatal before a receipt can be accepted", async () => {
  let aborts = 0;
  const { handlers, tools } = extension({
    shutdownReviewerAgent: async () => { throw new Error("snapshot cleanup failed"); },
  });
  await handlers.get("session_start")?.({}, {});
  const refusal = { status: "refused", report: "Cannot establish the target." };
  const ctx = context("cleanup");
  (ctx as any).abort = () => { aborts += 1; };
  await assert.rejects(
    tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
      "cleanup", refusal, undefined, undefined, ctx,
    ),
    /snapshot cleanup failed/,
  );
  assert.equal(aborts, 1);
});

test("copied, partial, alternate-path, and later Skill blocks do not establish provenance", async () => {
  for (const prompt of [
    `<skill name="code-review" location="${canonicalSkill.path}">\n${canonicalSkill.body}\n</skill>\n\nrequest`,
    `<skill name="code-review" location="/tmp/copy/SKILL.md">\nReferences are relative to /tmp/copy.\n\n${canonicalSkill.body}\n</skill>\n\nrequest`,
    `<skill name="code-review" location="${canonicalSkill.path}">\nReferences are relative to ${canonicalSkill.baseDir}.\n\n# Canonical\n</skill>\n\nrequest`,
  ]) {
    const { handlers } = extension();
    await handlers.get("session_start")?.({}, {});
    await handlers.get("input")?.({ text: "request" }, {});
    let aborts = 0;
    await assert.rejects(
      async () => handlers.get("before_agent_start")?.(
        { systemPrompt: "BASE", prompt },
        { abort() { aborts += 1; }, mode: "tui" },
      ),
      /canonical native code-review skill expansion/i,
    );
    assert.equal(aborts, 1);
  }
});

test("real Pi rejects completed when a schema-invalid Agent sibling never enters execute", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "ak-reviewer-malformed-sibling-"));
  const agentDir = resolve(temp, ".pi-agent");
  const skillDir = resolve(temp, "code-review");
  const skillPath = resolve(skillDir, "SKILL.md");
  const taskPath = resolve(temp, "review-task.md");
  const rawSkill = [
    "---",
    "name: code-review",
    "description: review",
    "---",
    "",
    "# Canonical review",
  ].join("\n");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let childStarts = 0;
  let audits = 0;
  try {
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, rawSkill);
    await writeFile(taskPath, "# Review task\nReview the fixed point.\n");
    const canonicalPath = await realpath(skillPath);
    const faux = fauxProvider({
      api: "ak-reviewer-malformed-sibling",
      provider: "ak-reviewer-malformed-sibling",
      tokenSize: { min: 1000, max: 1000 },
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(AGENT_TOOL_NAME, {
          subagent_type: "general-purpose",
          description: "Valid leg",
          prompt: "Inspect the fixed point.",
        }, { id: "valid-leg" }),
        fauxToolCall(AGENT_TOOL_NAME, {
          subagent_type: "general-purpose",
          description: "Invalid leg",
          prompt: "This must fail schema validation.",
          unexpected: true,
        }, { id: "invalid-leg" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, {
          status: "completed",
          report: "An always-pass auditor must not accept this.",
        }, { id: "completed-after-invalid" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Completion was rejected before audit."),
    ]);
    const model = faux.getModel();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    runtime.registerNativeProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Malformed sibling test auth",
          async resolve() { return { auth: { apiKey: "offline" } }; },
        },
      },
      getModels() { return [model]; },
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: temp,
      agentDir,
      settingsManager: settings,
      extensionFactories: [createRoleRuntimeExtension({
        loadJudgeSoul: async () => "judge",
        loadReviewerSoul: async () => "reviewer",
        loadReviewerTask: async () => "# Review task\nReview the fixed point.",
        loadCanonicalReviewerSkill: async () => ({
          raw: rawSkill,
          path: canonicalPath,
          baseDir: dirname(canonicalPath),
          body: "# Canonical review",
        }),
        runReviewerAgent: async () => {
          childStarts += 1;
          return { report: "valid report", workspaceDisposition: "deleted" };
        },
        transcriptFromContext: () => "",
        auditSoulCompliance: async () => ({ status: "pass" }),
        auditReviewerCompliance: async () => {
          audits += 1;
          return { status: "pass" };
        },
      })],
      additionalSkillPaths: [canonicalPath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "REVIEWER TEST BASE",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const sessionManager = SessionManager.inMemory(temp);
    ({ session } = await createAgentSession({
      cwd: temp,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager,
      settingsManager: settings,
      noTools: "builtin",
    }));
    session.extensionRunner.setFlagValue("ak-role", "reviewer");
    session.extensionRunner.setFlagValue("ak-review-task", taskPath);
    await session.bindExtensions({ mode: "tui" });

    await session.prompt("Review this fixed point.");

    const toolResults = sessionManager.getEntries().filter((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
    );
    const resultFor = (id: string) => toolResults.find((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === id
    );
    const valid = resultFor("valid-leg");
    const invalid = resultFor("invalid-leg");
    const completed = resultFor("completed-after-invalid");
    assert.ok(valid?.type === "message" && valid.message.role === "toolResult");
    assert.equal(valid.message.isError, false);
    assert.ok(invalid?.type === "message" && invalid.message.role === "toolResult");
    assert.equal(invalid.message.isError, true);
    const invalidText = invalid.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(invalidText, /unexpected|additional propert/i);
    assert.ok(completed?.type === "message" && completed.message.role === "toolResult");
    assert.equal(completed.message.isError, true);
    const completedText = completed.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(completedText, /exact one-to-one match/);
    assert.match(completedText, /invalid-leg/);
    assert.match(completedText, /unexpected|additional propert/i);
    assert.equal(childStarts, 1, "only the schema-valid sibling reaches execute");
    assert.equal(audits, 0, "completion reconciliation runs before the auditor");
    assert.equal(
      toolResults.some((entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === REVIEWER_OUTPUT_TOOL_NAME &&
        !entry.message.isError
      ),
      false,
    );
    assert.equal(faux.getPendingResponseCount(), 0);
  } finally {
    if (session !== undefined) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await rm(temp, { recursive: true, force: true });
  }
});

test("Reviewer schema is a thin exact non-routing envelope and output must be sole", async () => {
  const { handlers, tools } = extension();
  await handlers.get("session_start")?.({}, {});
  const schema = tools.get(REVIEWER_OUTPUT_TOOL_NAME).parameters;
  assert.deepEqual(Object.keys(schema.properties), ["status", "report"]);
  assert.equal(schema.additionalProperties, false);

  const tool = tools.get(REVIEWER_OUTPUT_TOOL_NAME);
  await assert.rejects(
    tool.execute(
      "mixed",
      { status: "refused", report: "No authority." },
      undefined,
      undefined,
      context("mixed", REVIEWER_OUTPUT_TOOL_NAME, [
        { id: "mixed", name: REVIEWER_OUTPUT_TOOL_NAME },
        { id: "other", name: "read" },
      ]),
    ),
    /sole final tool call/,
  );
});
