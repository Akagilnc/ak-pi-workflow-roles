import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
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
  const agentResult = await agent.execute(
    "axis-1",
    { subagent_type: "general-purpose", description: "Standards", prompt: "Inspect the pinned diff." },
    undefined,
    undefined,
    context("axis-1", AGENT_TOOL_NAME),
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
