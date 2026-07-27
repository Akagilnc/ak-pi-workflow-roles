import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createReviewerRoleRuntime } from "../src/reviewer-role.ts";
import {
  AGENT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  createRoleRuntimeExtension,
  type ReviewerAuditInput,
} from "../src/role-runtime.ts";
import type {
  CanonicalSkillBinding,
  CanonicalSkillSnapshot,
} from "../src/canonical-skill-binding.ts";
import {
  withHermeticHome,
  withInProcessPi,
} from "./helpers/pi-test-harness.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;

const canonicalSkill: CanonicalSkillSnapshot = {
  raw: "---\nname: code-review\ndescription: review\n---\n\n# Canonical review",
  path: "/home/test/.agents/skills/code-review/SKILL.md",
  baseDir: "/home/test/.agents/skills/code-review",
  body: "# Canonical review",
};

function reviewerBinding(
  snapshot: CanonicalSkillSnapshot = canonicalSkill,
): CanonicalSkillBinding<"code-review"> {
  return {
    name: "code-review",
    snapshot,
    invocation(originalRequest) {
      return `/skill:code-review ${originalRequest}`;
    },
    captureExpansion(prompt, originalRequest) {
      const content =
        `References are relative to ${snapshot.baseDir}.\n\n${snapshot.body}`;
      const expected =
        `<skill name="code-review" location="${snapshot.path}">\n${content}\n</skill>\n\n${originalRequest}`;
      return prompt === expected
        ? { name: "code-review", location: snapshot.path, content, userMessage: originalRequest }
        : undefined;
    },
  };
}

function harness() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const tools = new Map<string, any>();
  const registeredFlags: Array<[string, unknown]> = [];
  const activeToolSets: string[][] = [];
  const all = new Set(["read", "grep", "find", "ls", "bash", "write", "edit", "other"]);
  const flags: Record<string, string> = {
    "ak-role": "reviewer",
    "ak-review-task": "/task.md",
  };
  const pi = {
    registerFlag(name: string, options: unknown) { registeredFlags.push([name, options]); },
    getFlag(name: string) { return flags[name]; },
    on(name: string, fn: (event: any, ctx: any) => any) { handlers.set(name, fn); },
    registerTool(tool: any) { tools.set(tool.name, tool); all.add(tool.name); },
    getAllTools() { return [...all].map((name) => ({ name })); },
    setActiveTools(names: string[]) { activeToolSets.push(names); },
  };
  return { pi, handlers, tools, activeToolSets, registeredFlags };
}

function context(
  id: string,
  name = REVIEWER_OUTPUT_TOOL_NAME,
  calls: Array<{
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
  }> = [{ id, name }],
): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  const message: AssistantMessage = {
    role: "assistant",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
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
    loadCanonicalSkillBinding: async () => reviewerBinding(),
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

test("focused Reviewer controller owns its flag, tools, hooks, narrowing, and prompt", async () => {
  const h = harness();
  const runtime = createReviewerRoleRuntime(
    h.pi as unknown as ExtensionAPI,
    {
      loadSoul: async () => " REVIEWER LAW ",
      loadTask: async () => "RAW TASK\n",
      loadCanonicalSkillBinding: async () => reviewerBinding(),
      runAgent: async () => ({ report: "axis", workspaceDisposition: "deleted" }),
      auditCompliance: async () => ({ status: "pass" }),
    },
    { failInfrastructure(error) { throw error; } },
  );

  await runtime.activate();

  assert.deepEqual(h.registeredFlags, [["ak-review-task", {
    description: "Opaque Markdown review task assigned to the reviewer role",
    type: "string",
  }]]);
  assert.deepEqual([...h.tools.keys()], [AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME]);
  assert.deepEqual(h.activeToolSets, [[
    "read", "grep", "find", "ls", "bash", AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME,
  ]]);
  for (const hook of [
    "input", "before_agent_start", "tool_execution_start", "tool_execution_end",
    "tool_call", "tool_result", "session_shutdown",
  ]) assert.ok(h.handlers.has(hook), hook);
  const prompt = await h.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: "idle" },
    {},
  );
  assert.equal(
    prompt.systemPrompt,
    "BASE\n\n<reviewer_soul>\nREVIEWER LAW\n</reviewer_soul>\n\n<review_task>\nRAW TASK\n\n</review_task>",
  );
});

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
  assert.deepEqual([...tools.keys()], [AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME]);
  assert.deepEqual({
    label: tools.get(AGENT_TOOL_NAME).label,
    description: tools.get(AGENT_TOOL_NAME).description,
    promptSnippet: tools.get(AGENT_TOOL_NAME).promptSnippet,
    promptGuidelines: tools.get(AGENT_TOOL_NAME).promptGuidelines,
    executionMode: tools.get(AGENT_TOOL_NAME).executionMode,
  }, {
    label: "Agent",
    description: "Run one general-purpose review leg in an isolated writable clone at the pinned reviewed target.",
    promptSnippet: "Run an isolated review leg",
    promptGuidelines: [
      "Use Agent for the independent review legs required by the expanded canonical code-review Skill.",
    ],
    executionMode: "parallel",
  });
  assert.deepEqual({
    label: tools.get(REVIEWER_OUTPUT_TOOL_NAME).label,
    description: tools.get(REVIEWER_OUTPUT_TOOL_NAME).description,
    promptSnippet: tools.get(REVIEWER_OUTPUT_TOOL_NAME).promptSnippet,
    promptGuidelines: tools.get(REVIEWER_OUTPUT_TOOL_NAME).promptGuidelines,
  }, {
    label: "Reviewer Output",
    description: "Submit the completed review or an evidence-bearing refusal. Method compliance is audited before acceptance.",
    promptSnippet: "Submit the final Reviewer receipt",
    promptGuidelines: [
      `Use ${REVIEWER_OUTPUT_TOOL_NAME} as the sole final action for the reviewer role.`,
    ],
  });
  assert.equal(tools.get(AGENT_TOOL_NAME).executionMode, "parallel");
  assert.deepEqual(Object.keys(tools.get(AGENT_TOOL_NAME).parameters.properties), [
    "subagent_type", "description", "prompt",
  ]);
  assert.equal(tools.get(AGENT_TOOL_NAME).parameters.additionalProperties, false);
});

test("reviewer preserves leading indentation and terminal newline in prompts and audits", async () => {
  const rawTask = "    # Opaque request\nReview fixed point main.\n";
  const { handlers, tools, audits } = extension({
    loadReviewerTask: async () => rawTask,
  });
  await handlers.get("session_start")?.({}, {});

  const prompt = await handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: "review" },
    {},
  );
  assert.equal(
    prompt.systemPrompt,
    `BASE\n\n<reviewer_soul>\nREVIEWER LAW\n</reviewer_soul>\n\n<review_task>\n${rawTask}\n</review_task>`,
  );

  await tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
    "done",
    { status: "refused", report: "The target cannot be established." },
    undefined,
    undefined,
    context("done"),
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.task, rawTask);
});

test("completed requires exact native Skill provenance and successful Agent evidence", async () => {
  const successfulUsage: Usage = {
    input: 13,
    output: 17,
    cacheRead: 19,
    cacheWrite: 23,
    totalTokens: 72,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
  const { handlers, tools, audits } = extension({
    runReviewerAgent: async () => ({
      report: "axis report",
      usage: successfulUsage,
      targetSnapshot: {
        repositoryRoot: "/reviewed/repository",
        targetHead: "abc123",
        refs: { "refs/heads/main": "abc123" },
      },
      workspaceDisposition: { retained: "/tmp/retained-review" },
    }),
  });
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
  const axisParameters = {
    subagent_type: "general-purpose",
    description: "Standards",
    prompt: "Inspect the pinned diff.",
  };
  const axisContext = context("axis-1", AGENT_TOOL_NAME, [{
    id: "axis-1",
    name: AGENT_TOOL_NAME,
    arguments: axisParameters,
  }]);
  const agentResult = await agent.execute(
    "axis-1",
    axisParameters,
    undefined,
    undefined,
    axisContext,
  );
  assert.equal(agentResult.content[0].text, "axis report");
  assert.deepEqual(agentResult.usage, successfulUsage);
  assert.equal(agentResult.details.report, "axis report");
  assert.deepEqual(agentResult.details.usage, successfulUsage);
  assert.equal(agentResult.details.targetSnapshot.targetHead, "abc123");
  assert.deepEqual(agentResult.details.targetSnapshot.refs, {
    "refs/heads/main": "abc123",
  });
  assert.deepEqual(agentResult.details.workspaceDisposition, {
    retained: "/tmp/retained-review",
  });
  assert.ok(Object.isFrozen(agentResult.details));
  assert.ok(Object.isFrozen(agentResult.details.usage.cost));
  assert.ok(Object.isFrozen(agentResult.details.targetSnapshot.refs));

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
  assert.equal(audits[0]?.canonicalSkill, canonicalSkill.raw);
  assert.deepEqual(audits[0]?.record.skillEvidence, {
    name: "code-review",
    location: canonicalSkill.path,
    content: `References are relative to ${canonicalSkill.baseDir}.\n\n${canonicalSkill.body}`,
    userMessage: "Review the requested fixed point.",
  });
  assert.equal(audits[0]?.candidate.status, "completed");
  assert.equal(audits[0]?.record.agentAttempts.length, 1);
  assert.equal(audits[0]?.record.agentAttempts[0]?.report, "axis report");
  assert.deepEqual(audits[0]?.record.agentAttempts[0]?.usage, successfulUsage);
  assert.equal(audits[0]?.record.targetSnapshot?.targetHead, "abc123");
  assert.deepEqual(audits[0]?.record.targetSnapshot?.refs, {
    "refs/heads/main": "abc123",
  });
  assert.deepEqual(
    audits[0]?.record.agentAttempts[0]?.workspaceDisposition,
    { retained: "/tmp/retained-review" },
  );
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
    {
      id: "axis-a",
      name: AGENT_TOOL_NAME,
      arguments: {
        subagent_type: "general-purpose",
        description: "A",
        prompt: "A",
      },
    },
    {
      id: "axis-b",
      name: AGENT_TOOL_NAME,
      arguments: {
        subagent_type: "general-purpose",
        description: "B",
        prompt: "B",
      },
    },
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
  const later = context("later", AGENT_TOOL_NAME, [{
    id: "later",
    name: AGENT_TOOL_NAME,
    arguments: {
      subagent_type: "general-purpose",
      description: "Later",
      prompt: "Later",
    },
  }]);
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
            {
              id: "boundary",
              name: AGENT_TOOL_NAME,
              arguments: { description: scenario, prompt: scenario },
            },
            {
              id: "boundary",
              name: AGENT_TOOL_NAME,
              arguments: { description: scenario, prompt: scenario },
            },
          ]
        : [{
            id: "boundary",
            name: AGENT_TOOL_NAME,
            arguments: { description: "first", prompt: "first" },
          }],
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

test("first and start/execute Agent argument conflicts abort before child dispatch", async () => {
  for (const observation of ["first", "start-execute"] as const) {
    let childStarts = 0;
    let audits = 0;
    const fixture = extension({
      runReviewerAgent: async () => {
        childStarts += 1;
        return { report: "must not run", workspaceDisposition: "deleted" };
      },
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    const persistedArguments = {
      subagent_type: "general-purpose",
      description: "Persisted",
      prompt: "Persisted prompt",
    };
    const ctx = context("axis", AGENT_TOOL_NAME, [{
      id: "axis",
      name: AGENT_TOOL_NAME,
      arguments: persistedArguments,
    }]);
    let aborts = 0;
    (ctx as any).abort = () => { aborts += 1; };
    if (observation === "start-execute") {
      await fixture.handlers.get("tool_execution_start")?.({
        toolCallId: "axis",
        toolName: AGENT_TOOL_NAME,
        args: persistedArguments,
      }, ctx);
    }

    await assert.rejects(
      fixture.tools.get(AGENT_TOOL_NAME).execute(
        "axis",
        {
          subagent_type: "general-purpose",
          description: "Runtime",
          prompt: "Runtime prompt",
        },
        undefined,
        undefined,
        ctx,
      ),
      /runtime arguments.*disagree.*persisted/i,
    );
    assert.equal(aborts, 1);
    assert.equal(childStarts, 0);
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "done",
        { status: "refused", report: "the conflict is fatal" },
        undefined,
        undefined,
        context("done"),
      ),
      /infrastructure previously failed.*runtime arguments.*disagree/i,
    );
    assert.equal(audits, 0);
  }
});

test("successful and failed terminal Agent replay never starts another child", async () => {
  for (const terminal of ["successful", "failed"] as const) {
    let childStarts = 0;
    let audits = 0;
    const fixture = extension({
      runReviewerAgent: async () => {
        childStarts += 1;
        if (terminal === "failed") throw new Error("child failed once");
        return { report: "finished once", workspaceDisposition: "deleted" };
      },
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    const parameters = {
      subagent_type: "general-purpose",
      description: "Axis",
      prompt: "Inspect once.",
    };
    const ctx = context("axis", AGENT_TOOL_NAME, [{
      id: "axis",
      name: AGENT_TOOL_NAME,
      arguments: parameters,
    }]);
    let aborts = 0;
    (ctx as any).abort = () => { aborts += 1; };
    let terminalAttempt: unknown;
    if (terminal === "successful") {
      const result = await fixture.tools.get(AGENT_TOOL_NAME).execute(
        "axis", parameters, undefined, undefined, ctx,
      );
      terminalAttempt = result.details;
    } else {
      await assert.rejects(
        async () => {
          try {
            await fixture.tools.get(AGENT_TOOL_NAME).execute(
              "axis", parameters, undefined, undefined, ctx,
            );
          } catch (error) {
            terminalAttempt = (error as { reviewerAgentAttempt?: unknown })
              .reviewerAgentAttempt;
            throw error;
          }
        },
        /child failed once/,
      );
    }
    assert.equal((terminalAttempt as { status?: unknown }).status, terminal);

    let replayError: unknown;
    await assert.rejects(
      async () => {
        try {
          await fixture.tools.get(AGENT_TOOL_NAME).execute(
            "axis", parameters, undefined, undefined, ctx,
          );
        } catch (error) {
          replayError = error;
          throw error;
        }
      },
      new RegExp(`lifecycle.*already ${terminal}`, "i"),
    );
    assert.equal(
      (replayError as { reviewerAgentAttempt?: unknown }).reviewerAgentAttempt,
      undefined,
    );
    assert.equal((terminalAttempt as { status?: unknown }).status, terminal);
    assert.equal(childStarts, 1);
    assert.equal(aborts, terminal === "successful" ? 1 : 2);
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "done",
        { status: "refused", report: "terminal replay remains fatal" },
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

test("bash call and reverse result events remain paired by ID in audit order", async () => {
  const { handlers, tools, audits } = extension();
  await handlers.get("session_start")?.({}, {});
  handlers.get("tool_call")?.({
    toolName: "bash",
    toolCallId: "bash-first",
    input: { command: "git status --short" },
  }, {});
  handlers.get("tool_call")?.({
    toolName: "bash",
    toolCallId: "bash-second",
    input: { command: "git diff --check" },
  }, {});
  handlers.get("tool_result")?.({
    toolName: "bash",
    toolCallId: "bash-second",
    content: [{ type: "text", text: "clean" }],
    isError: false,
  }, {});
  handlers.get("tool_result")?.({
    toolName: "bash",
    toolCallId: "unknown",
    content: [{ type: "text", text: "ignored" }],
    isError: true,
  }, {});
  handlers.get("tool_result")?.({
    toolName: "bash",
    toolCallId: "bash-first",
    content: [{ type: "text", text: " M file" }],
    isError: true,
  }, {});

  await tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
    "done",
    { status: "refused", report: "Bash evidence establishes the refusal." },
    undefined,
    undefined,
    context("done"),
  );
  assert.deepEqual(audits[0]?.record.bashEvidence, [
    {
      toolCallId: "bash-first",
      command: "git status --short",
      result: " M file",
      isError: true,
    },
    {
      toolCallId: "bash-second",
      command: "git diff --check",
      result: "clean",
      isError: false,
    },
  ]);
});

test("auditor mutation cannot alter a fresh immutable revise resubmission record", async () => {
  const seen: ReviewerAuditInput["record"][] = [];
  let calls = 0;
  const { handlers, tools } = extension({
    runReviewerAgent: async () => ({
      report: "immutable report",
      usage: {
        ...usage,
        cost: { ...usage.cost, total: 7 },
      },
      targetSnapshot: {
        repositoryRoot: "/repo",
        targetHead: "fixed-head",
        refs: { "refs/heads/main": "fixed-head" },
      },
      workspaceDisposition: { retained: "/tmp/fixed-workspace" },
    }),
    auditReviewerCompliance: async (input: ReviewerAuditInput) => {
      calls += 1;
      seen.push(input.record);
      assert.ok(Object.isFrozen(input.record));
      assert.ok(Object.isFrozen(input.record.agentAttempts[0]?.usage?.cost));
      assert.throws(() => {
        (input.record.agentAttempts[0]!.targetSnapshot!.refs as any)[
          "refs/heads/main"
        ] = "auditor mutation";
      }, TypeError);
      assert.throws(() => {
        (input.record.agentAttempts[0]!.workspaceDisposition as any).retained =
          "auditor mutation";
      }, TypeError);
      assert.equal(
        input.record.agentAttempts[0]?.targetSnapshot?.refs["refs/heads/main"],
        "fixed-head",
      );
      return calls === 1
        ? { status: "revise" as const, violations: ["Resubmit unchanged evidence"] }
        : { status: "pass" as const };
    },
  });
  await handlers.get("session_start")?.({}, {});
  await establishExpansion(handlers);
  const axisParameters = {
    subagent_type: "general-purpose",
    description: "Axis",
    prompt: "Inspect.",
  };
  await tools.get(AGENT_TOOL_NAME).execute(
    "axis",
    axisParameters,
    undefined,
    undefined,
    context("axis", AGENT_TOOL_NAME, [{
      id: "axis",
      name: AGENT_TOOL_NAME,
      arguments: axisParameters,
    }]),
  );
  const candidate = { status: "completed", report: "Immutable review." };
  await assert.rejects(
    tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
      "first", candidate, undefined, undefined, context("first"),
    ),
    /Resubmit unchanged evidence/,
  );
  const accepted = await tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
    "second", candidate, undefined, undefined, context("second"),
  );

  assert.equal(accepted.terminate, true);
  assert.equal(calls, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.notEqual(seen[0]?.agentAttempts, seen[1]?.agentAttempts);
  assert.equal(seen[1]?.agentAttempts[0]?.report, "immutable report");
  assert.equal(seen[1]?.agentAttempts[0]?.usage?.cost.total, 7);
  assert.equal(
    seen[1]?.agentAttempts[0]?.targetSnapshot?.refs["refs/heads/main"],
    "fixed-head",
  );
  assert.deepEqual(seen[1]?.agentAttempts[0]?.workspaceDisposition, {
    retained: "/tmp/fixed-workspace",
  });
});

test("all representable unsettled, failed, and orphan completion states stop before audit", async () => {
  for (const scenario of ["running", "failed", "orphan"] as const) {
    let audits = 0;
    const fixture = extension({
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    await establishExpansion(fixture.handlers);
    const agentContext = context("axis", AGENT_TOOL_NAME, [{
      id: "axis",
      name: AGENT_TOOL_NAME,
      arguments: { description: "Axis", prompt: "Inspect." },
    }]);
    if (scenario !== "orphan") {
      fixture.handlers.get("tool_execution_start")?.({
        toolCallId: "axis",
        toolName: AGENT_TOOL_NAME,
        args: { description: "Axis", prompt: "Inspect." },
      }, agentContext);
    }
    if (scenario !== "running") {
      fixture.handlers.get("tool_execution_end")?.({
        toolCallId: scenario === "orphan" ? "orphan" : "axis",
        toolName: AGENT_TOOL_NAME,
        isError: true,
        result: { content: [{ type: "text", text: "schema rejected" }] },
      }, {});
    }

    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "done",
        { status: "completed", report: "must not audit" },
        undefined,
        undefined,
        context("done"),
      ),
      scenario === "running"
        ? /running attempts: axis/
        : scenario === "failed"
          ? /failed attempts: axis: schema rejected/
          : /extra attempts: orphan/,
    );
    assert.equal(audits, 0, `${scenario} stops before audit`);
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

test("audit and cleanup infrastructure preserve exact non-Error throw identity", async () => {
  const auditFailure = "audit string sentinel";
  {
    let aborts = 0;
    const fixture = extension({
      auditReviewerCompliance: async () => { throw auditFailure; },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    const ctx = context("audit-identity");
    (ctx as any).abort = () => { aborts += 1; };
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "audit-identity",
        { status: "refused", report: "reach the audit adapter" },
        undefined,
        undefined,
        ctx,
      ),
      (error) => {
        assert.equal(error, auditFailure);
        return true;
      },
    );
    assert.equal(aborts, 1);
  }

  const cleanupFailure = { kind: "cleanup sentinel" };
  {
    let aborts = 0;
    const fixture = extension({
      shutdownReviewerAgent: async () => { throw cleanupFailure; },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    const ctx = context("cleanup-identity");
    (ctx as any).abort = () => { aborts += 1; };
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "cleanup-identity",
        { status: "refused", report: "reach the cleanup adapter" },
        undefined,
        undefined,
        ctx,
      ),
      (error) => {
        assert.equal(error, cleanupFailure);
        return true;
      },
    );
    assert.equal(aborts, 1);
  }
});

test("a refusal cannot turn prior fatal Skill, Agent, audit, or cleanup state into a receipt", async () => {
  {
    let audits = 0;
    const fixture = extension({
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    await fixture.handlers.get("input")?.({ text: "request" }, {});
    await assert.rejects(
      async () => fixture.handlers.get("before_agent_start")?.(
        { systemPrompt: "BASE", prompt: "not the native expansion" },
        { abort() {}, mode: "tui" },
      ),
      /canonical native code-review Skill expansion/,
    );
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "skill-refusal",
        { status: "refused", report: "must remain fatal" },
        undefined,
        undefined,
        context("skill-refusal"),
      ),
      /infrastructure previously failed/,
    );
    assert.equal(audits, 0);
  }

  {
    let audits = 0;
    const fixture = extension({
      runReviewerAgent: async () => { throw new Error("child infrastructure failed"); },
      auditReviewerCompliance: async () => {
        audits += 1;
        return { status: "pass" as const };
      },
    });
    await fixture.handlers.get("session_start")?.({}, {});
    await establishExpansion(fixture.handlers);
    await assert.rejects(
      fixture.tools.get(AGENT_TOOL_NAME).execute(
        "fatal-agent",
        { subagent_type: "general-purpose", description: "Axis", prompt: "Inspect." },
        undefined,
        undefined,
        context("fatal-agent", AGENT_TOOL_NAME, [{
          id: "fatal-agent",
          name: AGENT_TOOL_NAME,
          arguments: {
            subagent_type: "general-purpose",
            description: "Axis",
            prompt: "Inspect.",
          },
        }]),
      ),
      /child infrastructure failed/,
    );
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        "agent-refusal",
        { status: "refused", report: "must remain fatal" },
        undefined,
        undefined,
        context("agent-refusal"),
      ),
      /infrastructure previously failed/,
    );
    assert.equal(audits, 0);
  }

  for (const stage of ["audit", "cleanup"] as const) {
    let audits = 0;
    const fixture = extension({
      auditReviewerCompliance: async () => {
        audits += 1;
        if (stage === "audit") throw new Error("audit infrastructure failed");
        return { status: "pass" as const };
      },
      ...(stage === "cleanup"
        ? {
            shutdownReviewerAgent: async () => {
              throw new Error("cleanup infrastructure failed");
            },
          }
        : {}),
    });
    await fixture.handlers.get("session_start")?.({}, {});
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        `${stage}-first`,
        { status: "refused", report: "first submission reaches fatal seam" },
        undefined,
        undefined,
        context(`${stage}-first`),
      ),
      new RegExp(`${stage} infrastructure failed`),
    );
    await assert.rejects(
      fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
        `${stage}-second`,
        { status: "refused", report: "must remain fatal" },
        undefined,
        undefined,
        context(`${stage}-second`),
      ),
      /infrastructure previously failed/,
    );
    assert.equal(audits, 1, `${stage} fatal state blocks resubmission before audit`);
  }
});

test("copied, partial, alternate-path, and later Skill blocks do not establish provenance", async () => {
  const exact = `<skill name="code-review" location="${canonicalSkill.path}">\nReferences are relative to ${canonicalSkill.baseDir}.\n\n${canonicalSkill.body}\n</skill>\n\nrequest`;
  const malformedPrompts = [
    `<skill name="code-review" location="${canonicalSkill.path}">\n${canonicalSkill.body}\n</skill>\n\nrequest`,
    `<skill name="code-review" location="/tmp/copy/SKILL.md">\nReferences are relative to /tmp/copy.\n\n${canonicalSkill.body}\n</skill>\n\nrequest`,
    `<skill name="code-review" location="${canonicalSkill.path}">\nReferences are relative to ${canonicalSkill.baseDir}.\n\n# Canonical\n</skill>\n\nrequest`,
    exact.replace('name="code-review"', 'name="tdd"'),
    exact.replace("\n\nrequest", "\n\na different request"),
    `task prose\n${exact}`,
    `${exact}\nassistant prose`,
  ];
  for (const prompt of malformedPrompts) {
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

  const later = extension();
  await later.handlers.get("session_start")?.({}, {});
  await later.handlers.get("input")?.({ text: "request" }, {});
  await assert.rejects(
    async () => later.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE", prompt: malformedPrompts[0] },
      { abort() {}, mode: "tui" },
    ),
    /canonical native code-review skill expansion/i,
  );
  await later.handlers.get("before_agent_start")?.(
    { systemPrompt: "BASE", prompt: exact },
    { abort() {}, mode: "tui" },
  );
  await assert.rejects(
    later.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
      "later-refusal",
      { status: "refused", report: "Later evidence cannot repair provenance." },
      undefined,
      undefined,
      context("later-refusal"),
    ),
    /infrastructure previously failed/i,
  );
});

test("real Pi rejects completed when a schema-invalid Agent sibling never enters execute", async () => {
  await withHermeticHome(
    { prefix: "ak-reviewer-malformed-sibling-" },
    async ({ home: temp, agentDir }) => {
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
      let childStarts = 0;
      let audits = 0;
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
      await withInProcessPi({
        cwd: temp,
        agentDir,
        faux,
        modelsPath: null,
        extensionFactories: [createRoleRuntimeExtension({
          loadJudgeSoul: async () => "judge",
          loadReviewerSoul: async () => "reviewer",
          loadReviewerTask: async () =>
            "# Review task\nReview the fixed point.",
          loadCanonicalSkillBinding: async () =>
            reviewerBinding({
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
        systemPrompt: "REVIEWER TEST BASE",
        mode: "tui",
        flags: {
          "ak-role": "reviewer",
          "ak-review-task": taskPath,
        },
        noTools: "builtin",
        reviewerShutdown: true,
      }, async ({ loader, session, sessionManager }) => {
        assert.deepEqual(loader.getExtensions().errors, []);

        await session.prompt("Review this fixed point.");

        const toolResults = sessionManager.getEntries().filter((entry) =>
          entry.type === "message" && entry.message.role === "toolResult"
        );
        const resultFor = (id: string) =>
          toolResults.find((entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolCallId === id
          );
        const valid = resultFor("valid-leg");
        const invalid = resultFor("invalid-leg");
        const completed = resultFor("completed-after-invalid");
        assert.ok(
          valid?.type === "message" && valid.message.role === "toolResult",
        );
        assert.equal(valid.message.isError, false);
        assert.ok(
          invalid?.type === "message" && invalid.message.role === "toolResult",
        );
        assert.equal(invalid.message.isError, true);
        const invalidText = invalid.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.match(invalidText, /unexpected|additional propert/i);
        assert.ok(
          completed?.type === "message" &&
            completed.message.role === "toolResult",
        );
        assert.equal(completed.message.isError, true);
        const completedText = completed.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.match(completedText, /exact one-to-one match/);
        assert.match(completedText, /invalid-leg/);
        assert.match(completedText, /unexpected|additional propert/i);
        assert.equal(
          childStarts,
          1,
          "only the schema-valid sibling reaches execute",
        );
        assert.equal(
          audits,
          0,
          "completion reconciliation runs before the auditor",
        );
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
      });
    },
  );
});

test("Reviewer lifecycle chronology preserves Skill, Agent, bash, audit, cleanup, and termination", async () => {
  const chronology: string[] = [];
  const baseBinding = reviewerBinding();
  const fixture = extension({
    loadReviewerSoul: async () => { chronology.push("load soul"); return "reviewer"; },
    loadReviewerTask: async () => { chronology.push("load task"); return "raw task"; },
    loadCanonicalSkillBinding: async () => {
      chronology.push("load binding");
      return {
        ...baseBinding,
        invocation(request: string) {
          chronology.push("Skill invocation");
          return baseBinding.invocation(request);
        },
        captureExpansion(prompt: string, request: string) {
          chronology.push("Skill capture");
          return baseBinding.captureExpansion(prompt, request);
        },
      };
    },
    runReviewerAgent: async () => {
      chronology.push("child result");
      return { report: "axis report", usage, workspaceDisposition: "deleted" };
    },
    auditReviewerCompliance: async (input: ReviewerAuditInput) => {
      chronology.push("output validation and audit");
      assert.equal(input.record.skillEvidence?.name, "code-review");
      assert.equal(input.record.agentAttempts[0]?.status, "successful");
      assert.deepEqual(input.record.bashEvidence, [{
        toolCallId: "bash-proof",
        command: "git diff --check",
        result: "clean",
        isError: false,
      }]);
      return { status: "pass" as const, usage };
    },
    shutdownReviewerAgent: async () => { chronology.push("shutdown"); },
  });
  await fixture.handlers.get("session_start")?.({}, {});
  const request = "Review the requested fixed point.";
  await fixture.handlers.get("input")?.({ text: request }, {});
  await fixture.handlers.get("before_agent_start")?.({
    systemPrompt: "BASE",
    prompt: `<skill name="code-review" location="${canonicalSkill.path}">\nReferences are relative to ${canonicalSkill.baseDir}.\n\n${canonicalSkill.body}\n</skill>\n\n${request}`,
  }, { abort() {}, mode: "tui" });
  const parameters = {
    subagent_type: "general-purpose",
    description: "Chronology",
    prompt: "Inspect.",
  };
  const agentContext = context("chronology-agent", AGENT_TOOL_NAME, [{
    id: "chronology-agent",
    name: AGENT_TOOL_NAME,
    arguments: parameters,
  }]);
  await fixture.handlers.get("tool_execution_start")?.({
    toolCallId: "chronology-agent",
    toolName: AGENT_TOOL_NAME,
    args: parameters,
  }, agentContext);
  await fixture.tools.get(AGENT_TOOL_NAME).execute(
    "chronology-agent", parameters, undefined, undefined, agentContext,
  );
  await fixture.handlers.get("tool_execution_end")?.({
    toolCallId: "chronology-agent",
    toolName: AGENT_TOOL_NAME,
    isError: false,
    result: "axis report",
  }, {});
  await fixture.handlers.get("tool_call")?.({
    toolName: "bash",
    toolCallId: "bash-proof",
    input: { command: "git diff --check" },
  }, {});
  await fixture.handlers.get("tool_result")?.({
    toolName: "bash",
    toolCallId: "bash-proof",
    content: [{ type: "text", text: "clean" }],
    isError: false,
  }, {});
  const accepted = await fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME).execute(
    "chronology-output",
    { status: "completed", report: "Chronological evidence." },
    undefined,
    undefined,
    context("chronology-output"),
  );

  assert.deepEqual(chronology, [
    "load soul",
    "load task",
    "load binding",
    "Skill invocation",
    "Skill capture",
    "child result",
    "output validation and audit",
    "shutdown",
  ]);
  assert.deepEqual(accepted.content, [{ type: "text", text: "Reviewer report accepted" }]);
  assert.deepEqual(accepted.usage, usage);
  assert.equal(accepted.terminate, true);
});

test("Reviewer output accepts both statuses and rejects malformed or unknown envelopes before audit", async () => {
  let audits = 0;
  const fixture = extension({
    auditReviewerCompliance: async () => {
      audits += 1;
      return { status: "pass" as const };
    },
  });
  await fixture.handlers.get("session_start")?.({}, {});
  const tool = fixture.tools.get(REVIEWER_OUTPUT_TOOL_NAME);
  for (const [index, output] of [
    { status: "completed", report: "Completed evidence." },
    { status: "refused", report: "Refusal evidence." },
  ].entries()) {
    if (output.status === "completed") {
      await establishExpansion(fixture.handlers);
      const parameters = {
        subagent_type: "general-purpose",
        description: "Axis",
        prompt: "Inspect.",
      };
      await fixture.tools.get(AGENT_TOOL_NAME).execute(
        "legal-axis",
        parameters,
        undefined,
        undefined,
        context("legal-axis", AGENT_TOOL_NAME, [{
          id: "legal-axis", name: AGENT_TOOL_NAME, arguments: parameters,
        }]),
      );
    }
    const id = `legal-${index}`;
    assert.deepEqual((await tool.execute(
      id, output, undefined, undefined, context(id),
    )).details, output);
  }
  assert.equal(audits, 2);

  const malformed: unknown[] = [
    null,
    [],
    { status: "unknown", report: "evidence" },
    { status: "refused", report: " \n" },
    { status: "refused" },
    { status: "refused", report: "evidence", route: "judge" },
  ];
  for (const [index, output] of malformed.entries()) {
    const id = `malformed-reviewer-${index}`;
    await assert.rejects(
      tool.execute(id, output, undefined, undefined, context(id)),
      /Reviewer output requires/,
    );
  }
  assert.equal(audits, 2);
});

test("Reviewer schema is a thin exact non-routing envelope and output must be sole", async () => {
  const { handlers, tools } = extension();
  await handlers.get("session_start")?.({}, {});
  const schema = tools.get(REVIEWER_OUTPUT_TOOL_NAME).parameters;
  assert.deepEqual(Object.keys(schema.properties), ["status", "report"]);
  assert.equal(schema.additionalProperties, false);

  const tool = tools.get(REVIEWER_OUTPUT_TOOL_NAME);
  for (const ctx of [
    context("mixed", REVIEWER_OUTPUT_TOOL_NAME, [
      { id: "mixed", name: REVIEWER_OUTPUT_TOOL_NAME },
      { id: "other", name: "read" },
    ]),
    context("missing", REVIEWER_OUTPUT_TOOL_NAME, []),
    context("wrong-id"),
    context("wrong-name", "read"),
    (() => ({
      sessionManager: SessionManager.inMemory(),
      abort() {},
      mode: "tui",
    } as unknown as ExtensionContext))(),
  ]) {
    await assert.rejects(
      tool.execute(
        "mixed",
        { status: "refused", report: "No authority." },
        undefined,
        undefined,
        ctx,
      ),
      /sole final tool call/,
    );
  }
});
