import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUDITOR_TURN_LIMIT, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, AuditorTurnLimitError, runAuditorRole } from "../../src/auditor-role.ts";
import { ComplianceResponseRetentionError, createComplianceDecisionTool, runComplianceAudit } from "../../src/compliance-transport.ts";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, StreamIdleTimeoutError } from "../../src/stream-idle-guard.ts";

function retainedComplianceResponses(sessionManager: SessionManager): AssistantMessage[] {
  return sessionManager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "ak_compliance_response")
    .map((entry) => ((entry as { data: { response: AssistantMessage } }).data.response));
}

function auditorContext(cwd: string, provider: Provider, options: { model?: Model<any>; sessionManager?: SessionManager } = {}): ExtensionContext {
  return {
    cwd,
    model: options.model ?? provider.getModels()[0],
    modelRegistry: {
      getProvider() { return provider; },
      async getProviderAuth() { return { auth: { apiKey: "test-secret" } }; },
      async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test-secret" }; },
    },
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
  } as unknown as ExtensionContext;
}

test("constant unknown tools receive error results and exhaust at a finite typed boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-unknown-"));
  try {
    const faux = fauxProvider({ provider: "audit-unknown" });
    const seen: Context[] = [];
    faux.setResponses(Array.from({ length: AUDITOR_TURN_LIMIT }, () => (context: Context) => {
      seen.push(context);
      return fauxAssistantMessage([fauxToolCall("ak_other_decision", { status: "pass" })], { stopReason: "toolUse" });
    }));
    const sessionManager = SessionManager.inMemory(cwd);
    const context = auditorContext(cwd, faux.provider, { model: faux.getModel(), sessionManager });
    const tool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    await assert.rejects(
      runComplianceAudit({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool, roleLabel: "Test auditor", invalidDecisionLabel: "invalid", context }),
      (error: unknown) => {
        assert.ok(error instanceof AuditorTurnLimitError);
        assert.equal(error.limit, AUDITOR_TURN_LIMIT);
        assert.equal(error.observedTurns, AUDITOR_TURN_LIMIT);
        assert.deepEqual(error.lastResponse?.toolNames, ["ak_other_decision"]);
        return true;
      },
    );
    assert.equal(seen.length, AUDITOR_TURN_LIMIT);
    assert.equal(retainedComplianceResponses(sessionManager).length, AUDITOR_TURN_LIMIT);
    for (const nextTurn of seen.slice(1)) {
      const result = nextTurn.messages.find((message) => message.role === "toolResult" && message.toolName === "ak_other_decision");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, true);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider and decision-tool failures on the limit turn retain their original identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-boundary-cause-"));
  try {
    const faux = fauxProvider({ provider: "audit-boundary-cause" });
    const sessionManager = SessionManager.inMemory(cwd);
    const context = auditorContext(cwd, faux.provider, { model: faux.getModel(), sessionManager });
    const unknown = () => fauxAssistantMessage([fauxToolCall("ak_other_decision", {})], { stopReason: "toolUse" });

    const providerFailure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed at boundary" });
    faux.setResponses([...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown), providerFailure]);
    await assert.rejects(
      runComplianceAudit({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: createComplianceDecisionTool("ak_boundary_provider", "Submit."), roleLabel: "Test auditor", invalidDecisionLabel: "invalid", context }),
      (error: unknown) => {
        assert.ok(!(error instanceof AuditorTurnLimitError));
        assert.equal((error as { role?: unknown }).role, "assistant");
        assert.equal((error as { stopReason?: unknown }).stopReason, "error");
        assert.equal((error as { errorMessage?: unknown }).errorMessage, "provider failed at boundary");
        return true;
      },
    );
    assert.deepEqual(retainedComplianceResponses(sessionManager).at(-1)?.content, providerFailure.content);

    const toolFailure = new Error("decision execution failed at boundary");
    const baseTool = createComplianceDecisionTool("ak_boundary_tool", "Submit.");
    const failingTool = { ...baseTool, async execute() { throw toolFailure; } };
    faux.setResponses([
      ...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown),
      fauxAssistantMessage([fauxToolCall(failingTool.name, { status: "pass" })], { stopReason: "toolUse" }),
    ]);
    await assert.rejects(
      runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: failingTool, roleLabel: "Test auditor", context }),
      (error: unknown) => error === toolFailure,
    );

    for (const includeDecision of [false, true]) {
      faux.setResponses([
        ...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown),
        fauxAssistantMessage([
          fauxToolCall("read", { path: "missing.txt" }),
          ...(includeDecision ? [fauxToolCall(baseTool.name, { status: "pass" })] : []),
        ], { stopReason: "toolUse" }),
      ]);
      const retainedBefore = retainedComplianceResponses(sessionManager).length;
      await assert.rejects(
        runComplianceAudit({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: baseTool, roleLabel: "Test auditor", invalidDecisionLabel: "invalid", context }),
        (error: unknown) => {
          assert.ok(!(error instanceof AuditorTurnLimitError));
          assert.equal((error as { role?: unknown }).role, "toolResult");
          assert.equal((error as { toolName?: unknown }).toolName, "read");
          assert.equal((error as { isError?: unknown }).isError, true);
          return true;
        },
      );
      assert.equal(retainedComplianceResponses(sessionManager).length - retainedBefore, AUDITOR_TURN_LIMIT);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("parent and typed idle cancellation win over exhaustion on the limit turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-boundary-abort-"));
  try {
    for (const reason of [new Error("parent aborted at boundary"), new StreamIdleTimeoutError(17)]) {
      const faux = fauxProvider({ provider: "audit-boundary-abort" });
      const controller = new AbortController();
      const baseTool = createComplianceDecisionTool("ak_boundary_abort", "Submit.");
      const tool = { ...baseTool, async execute(...args: Parameters<typeof baseTool.execute>) {
        controller.abort(reason);
        return baseTool.execute(...args);
      } };
      const unknown = () => fauxAssistantMessage([fauxToolCall("ak_other_decision", {})], { stopReason: "toolUse" });
      faux.setResponses([
        ...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown),
        fauxAssistantMessage([fauxToolCall(tool.name, { status: "pass" })], { stopReason: "toolUse" }),
      ]);
      const context = auditorContext(cwd, faux.provider, { model: faux.getModel() });
      await assert.rejects(
        runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool, roleLabel: "Test auditor", context, signal: controller.signal }),
        (error: unknown) => error === reason,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("real provider stream idle signal retains its typed cause at the turn boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-boundary-idle-"));
  try {
    const faux = fauxProvider({ provider: "audit-boundary-idle" });
    const unknown = () => fauxAssistantMessage([fauxToolCall("ak_other_decision", {})], { stopReason: "toolUse" });
    faux.setResponses(Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown));
    let streams = 0;
    const provider: Provider = {
      ...faux.provider,
      stream(model, context, options) {
        streams += 1;
        if (streams < AUDITOR_TURN_LIMIT) return faux.provider.stream(model, context, options);
        const stream = createAssistantMessageEventStream();
        options?.signal?.addEventListener("abort", () => {
          stream.push({ type: "error", reason: "error", error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "idle" }) });
        }, { once: true });
        return stream;
      },
      streamSimple(model, context, options) { return this.stream(model, context, options); },
    };
    const context = auditorContext(cwd, provider, { model: faux.getModel() });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => realSetTimeout(handler, delay === DEFAULT_STREAM_IDLE_TIMEOUT_MS ? 20 : delay, ...args)) as typeof setTimeout;
    try {
      await assert.rejects(
        runAuditorRole({ systemPrompt: "Decide.", serializedInput: "Inspect.", tool: createComplianceDecisionTool("ak_boundary_idle", "Submit."), roleLabel: "Test auditor", context }),
        (error: unknown) => error instanceof StreamIdleTimeoutError && error.idleTimeoutMs === DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(streams, AUDITOR_TURN_LIMIT + DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("idle retries only StreamIdleTimeoutError and succeeds on the bounded final attempt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-idle-retry-"));
  try {
    const faux = fauxProvider({ provider: "audit-idle-retry" });
    const tool = createComplianceDecisionTool("ak_idle_retry", "Submit.");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(tool.name, { status: "pass" })], { stopReason: "toolUse" }),
    ]);
    let attempts = 0;
    const provider: Provider = {
      ...faux.provider,
      stream(model, context, options) {
        attempts += 1;
        if (attempts > DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES) return faux.provider.stream(model, context, options);
        const stream = createAssistantMessageEventStream();
        options?.signal?.addEventListener("abort", () => {
          stream.push({ type: "error", reason: "error", error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "idle" }) });
        }, { once: true });
        return stream;
      },
      streamSimple(model, context, options) { return this.stream(model, context, options); },
    };
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => realSetTimeout(handler, delay === DEFAULT_STREAM_IDLE_TIMEOUT_MS ? 10 : delay, ...args)) as typeof setTimeout;
    try {
      const decision = await runComplianceAudit({ tool, systemPrompt: "Decide.", serializedInput: "Inspect.", roleLabel: "Test auditor", invalidDecisionLabel: "invalid", context: auditorContext(cwd, provider, { model: faux.getModel() }) });
      assert.equal(decision.status, "pass");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(attempts, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("injected and AgentSession terminal responses settle unreadable decisions as audit-incomplete", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-unreadable-"));
  try {
    const tool = createComplianceDecisionTool("ak_unreadable", "Submit.");
    for (const injected of [true, false]) {
      const faux = fauxProvider({ provider: `audit-unreadable-${injected}` });
      const response = fauxAssistantMessage("terminal prose without a decision", { stopReason: "stop" });
      const sessionManager = SessionManager.inMemory(cwd);
      if (!injected) faux.setResponses([response]);
      const decision = await runComplianceAudit({
        tool,
        systemPrompt: "Decide.",
        serializedInput: "Inspect.",
        roleLabel: "Test auditor",
        invalidDecisionLabel: "invalid",
        context: auditorContext(cwd, faux.provider, { model: faux.getModel(), sessionManager }),
        ...(injected ? { runCompletion: async () => response } : {}),
      });
      assert.equal(decision.status, "audit-incomplete");
      if (decision.status === "audit-incomplete") assert.equal(decision.candidate, undefined);
      const retained = sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "ak_compliance_response");
      assert.ok(retained?.type === "custom");
      const retainedResponse = (retained.data as { response?: AssistantMessage }).response;
      if (injected) assert.equal(retainedResponse, response);
      else assert.deepEqual(retainedResponse?.content, response.content);
    }

    for (const stopReason of ["error", "aborted"] as const) {
      const faux = fauxProvider({ provider: `audit-injected-${stopReason}` });
      const response = fauxAssistantMessage("provider stopped", { stopReason, errorMessage: stopReason });
      const sessionManager = SessionManager.inMemory(cwd);
      await assert.rejects(
        runComplianceAudit({
          tool,
          systemPrompt: "Decide.",
          serializedInput: "Inspect.",
          roleLabel: "Test auditor",
          invalidDecisionLabel: "invalid",
          context: auditorContext(cwd, faux.provider, { model: faux.getModel(), sessionManager }),
          runCompletion: async () => response,
        }),
        (error: unknown) => error === response,
      );
      const retained = sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "ak_compliance_response");
      assert.ok(retained?.type === "custom");
      assert.equal((retained.data as { response?: AssistantMessage }).response, response);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retention failure after a decision on the limit turn retains its typed cause", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-boundary-retention-"));
  try {
    const faux = fauxProvider({ provider: "audit-boundary-retention" });
    const tool = createComplianceDecisionTool("ak_boundary_retention", "Submit.");
    const unknown = () => fauxAssistantMessage([fauxToolCall("ak_other_decision", {})], { stopReason: "toolUse" });
    faux.setResponses([
      ...Array.from({ length: AUDITOR_TURN_LIMIT - 1 }, unknown),
      fauxAssistantMessage([fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })], { stopReason: "toolUse" }),
    ]);
    const retentionCause = new Error("session write failed");
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry = () => { throw retentionCause; };
    const context = auditorContext(cwd, faux.provider, { model: faux.getModel(), sessionManager });
    await assert.rejects(
      runComplianceAudit({ tool, systemPrompt: "Decide.", serializedInput: "Inspect.", roleLabel: "Test auditor", invalidDecisionLabel: "invalid", context }),
      (error: unknown) => error instanceof ComplianceResponseRetentionError && error.cause === retentionCause,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed evidence and decision in an ordinary turn retains the evidence failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-same-turn-failure-"));
  try {
    const faux = fauxProvider({ provider: "audit-same-turn-failure" });
    const tool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "missing.txt" }),
        fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ], { stopReason: "toolUse" }),
    ]);
    await assert.rejects(
      runAuditorRole({
        systemPrompt: "Inspect and decide.",
        serializedInput: "Inspect missing.txt and decide.",
        tool,
        roleLabel: "Test auditor",
        context: auditorContext(cwd, faux.provider, { model: faux.getModel() }),
      }),
      (error: unknown) => {
        assert.equal((error as { role?: unknown }).role, "toolResult");
        assert.equal((error as { toolName?: unknown }).toolName, "read");
        assert.equal((error as { isError?: unknown }).isError, true);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("evidence and decision calls in the same assistant turn succeed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-same-turn-"));
  try {
    await writeFile(join(cwd, "evidence.txt"), "same-turn evidence\n");
    const faux = fauxProvider({ provider: "audit-same-turn" });
    const tool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "evidence.txt" }),
        fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ], { stopReason: "toolUse" }),
    ]);
    const result = await runAuditorRole({
      systemPrompt: "Inspect and decide.",
      serializedInput: "Inspect evidence.txt and decide.",
      tool,
      roleLabel: "Test auditor",
      context: auditorContext(cwd, faux.provider, { model: faux.getModel() }),
    });
    assert.deepEqual(result.decision, { status: "pass", violations: [], conflicts: [], decisionGate: null });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("independent auditor gathers evidence and submits one decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ak-auditor-behavior-"));
  try {
    await writeFile(join(cwd, "evidence.txt"), "court evidence: accepted\n");
    const sessionManager = SessionManager.inMemory(cwd);
    const baseTool = createComplianceDecisionTool("ak_test_auditor_decision", "Submit the decision.");
    let decisions = 0;
    const tool = { ...baseTool, async execute(...args: Parameters<typeof baseTool.execute>) { decisions += 1; return baseTool.execute(...args); } };
    let turns = 0;
    const complete = (context: Context) => {
      turns += 1;
      if (turns === 1) return fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })], { stopReason: "toolUse" });
      assert.ok(context.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("court evidence: accepted")));
      return fauxAssistantMessage([fauxToolCall(tool.name, { status: "pass", violations: [], conflicts: [], decisionGate: null })], { stopReason: "toolUse" });
    };
    const faux = fauxProvider({ provider: "audit-test" });
    faux.setResponses([complete, complete]);
    const decision = await runComplianceAudit({
      tool,
      systemPrompt: "Read the supplied evidence, then submit exactly one decision.",
      serializedInput: "Inspect evidence.txt and decide.",
      roleLabel: "Test auditor",
      invalidDecisionLabel: "invalid test decision",
      context: auditorContext(cwd, faux.provider, { model: faux.getModel(), sessionManager }),
    });
    assert.equal(decision.status, "pass");
    assert.equal(turns, 2);
    assert.equal(decisions, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
