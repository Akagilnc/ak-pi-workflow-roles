import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  COMPLIANCE_RESPONSE_ENTRY_TYPE,
  ComplianceDecisionContractError,
  DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../../src/compliance-transport.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

const decisionToolName = "ak_test_compliance_decision";
const decisionTool = createComplianceDecisionTool(
  decisionToolName,
  "Return the compliance decision.",
);

function context(sessionManager: SessionManager): ExtensionContext {
  return {
    model: {
      api: "openai-responses",
      provider: "audit-test",
      id: "audit-model",
    },
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { apiKey: "test-secret" } };
      },
      async getApiKeyAndHeaders() {
        return { ok: true as const, apiKey: "test-secret" };
      },
    },
    sessionManager,
  } as unknown as ExtensionContext;
}

function response(
  id: string,
  content: AssistantMessage["content"],
  options: {
    stopReason?: AssistantMessage["stopReason"];
    errorMessage?: string;
    diagnostics?: AssistantMessage["diagnostics"];
  } = {},
): AssistantMessage {
  const message = fauxAssistantMessage(content, {
    responseId: id,
    ...(options.stopReason === undefined ? {} : { stopReason: options.stopReason }),
    ...(options.errorMessage === undefined
      ? {}
      : { errorMessage: options.errorMessage }),
  });
  message.responseModel = "audit-response-model";
  if (options.diagnostics !== undefined) {
    message.diagnostics = options.diagnostics;
  }
  return message;
}

function persistedResponse(
  sessionManager: SessionManager,
  responseId: string,
): AssistantMessage {
  const entry = sessionManager.getEntries().find((candidate) => {
    if (candidate.type !== "custom" || candidate.customType !== COMPLIANCE_RESPONSE_ENTRY_TYPE) return false;
    const data = candidate.data;
    const response = data && typeof data === "object" && !Array.isArray(data)
      ? (data as { response?: unknown }).response
      : undefined;
    return typeof response === "object" && response !== null &&
      (response as { responseId?: unknown }).responseId === responseId;
  });
  assert.ok(entry?.type === "custom");
  const data = entry.data as { version: number; response: AssistantMessage };
  assert.equal(data.version, 1);
  return data.response;
}

async function withPersistedSession<T>(
  callback: (sessionManager: SessionManager) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ak-compliance-transport-"));
  return await withPrimaryAwareCleanup(
    () => callback(SessionManager.create(root, resolve(root, "sessions"))),
    () => rm(root, { recursive: true, force: true }),
  );
}

function audit(responseMessage: AssistantMessage, sessionManager: SessionManager) {
  return runComplianceAudit({
    tool: decisionTool,
    systemPrompt: "audit system",
    serializedInput: "audit input",
    roleLabel: "Compliance",
    invalidDecisionLabel: "invalid compliance decision",
    runCompletion: async () => responseMessage,
    context: context(sessionManager),
  });
}

function diagnosticFacts(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof Error);
  const details = (error as Error & { details?: unknown }).details;
  assert.ok(details && typeof details === "object" && !Array.isArray(details));
  return details as Record<string, unknown>;
}

function defaultCompletionContext(
  sessionManager: SessionManager,
  stream: (options: Record<string, unknown>) => Promise<AssistantMessage>,
  seen: { options?: Record<string, unknown> },
): ExtensionContext {
  const base = context(sessionManager);
  return {
    ...base,
    modelRegistry: {
      ...(base.modelRegistry as object),
      getProvider() {
        return {
          stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
            seen.options = options;
            return {
              async *[Symbol.asyncIterator]() {
                return;
              },
              result: () => stream(options),
            };
          },
        };
      },
    },
  } as unknown as ExtensionContext;
}

test("default compliance completion sends the production timeout and merges parent signal into idle guard", async () => {
  await withPersistedSession(async (sessionManager) => {
    const seen: { options?: Record<string, unknown> } = {};
    const parent = new AbortController();
    const auditContext = defaultCompletionContext(
      sessionManager,
      async () => response("default-healthy", [
        fauxToolCall(decisionToolName, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ]),
      seen,
    );
    const decision = await runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: auditContext,
      signal: parent.signal,
    });
    assert.equal(decision.status, "pass");
    assert.equal("constrainedSampling" in decisionTool, false);
    assert.equal(seen.options?.timeoutMs, 183000);
    assert.ok(seen.options?.signal instanceof AbortSignal);
    assert.notStrictEqual(seen.options?.signal, parent.signal);
    assert.equal("onResponse" in (seen.options ?? {}), false);
    assert.deepEqual(Object.keys(seen.options ?? {}).sort(), [
      "apiKey", "cacheRetention", "maxTokens", "onPayload", "sessionId", "signal", "timeoutMs", "toolChoice",
    ]);
  });
});

test("a valid decision is accepted by name alongside sibling tool calls", async () => {
  await withPersistedSession(async (sessionManager) => {
    const decision = await audit(response("decision-with-sibling", [
      fauxToolCall("read", { path: "evidence.txt" }),
      fauxToolCall(decisionToolName, { status: "pass" }),
    ]), sessionManager);
    assert.equal(decision.status, "pass");
  });
});

test("a timeout-honoring provider terminates the real default seam with typed cause and no receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    const seen: { options?: Record<string, unknown> } = {};
    const auditContext = defaultCompletionContext(
      sessionManager,
      (options) => new Promise<AssistantMessage>((resolve) => {
        // This provider honors the exact production deadline. The test clock
        // advances it without sleeping for 183 seconds.
        if (typeof options.timeoutMs !== "number" || options.timeoutMs <= 0) return;
        setTimeout(() => resolve(response("default-timeout", [], {
          stopReason: "error",
          errorMessage: "provider timeout: compliance request expired",
        })), options.timeoutMs);
      }),
      seen,
    );
    const started = Date.now();
    const failure = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: auditContext,
      // Isolate header timeoutMs from the body-idle clock (same default numeric value, distinct seam).
      idleTimeoutMs: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(183000);
    await assert.rejects(
      failure,
      (error: unknown) => {
        assert.ok(error instanceof ComplianceDecisionContractError);
        assert.equal(error.name, "ComplianceDecisionContractError");
        assert.equal(error.details.responseStopReason, "error");
        assert.equal(error.details.provider, "faux");
        assert.equal(error.details.errorMessage, "provider timeout: compliance request expired");
        return true;
      },
    );
    assert.ok(Date.now() - started < 1000);
    assert.equal(seen.options?.timeoutMs, 183000);
    assert.equal(
      sessionManager.getEntries().some((entry) => entry.type === "message"),
      false,
    );
  });
});

test("shared compliance transport retains valid nested decisions verbatim", async () => {
  const cases = [
    {
      status: "pass" as const,
      arguments: { status: "pass", violations: [], conflicts: [], decisionGate: null },
    },
    {
      status: "revise" as const,
      arguments: {
        status: "revise",
        violations: ["one violation"],
        conflicts: [],
        decisionGate: null,
      },
    },
    {
      status: "escalate" as const,
      arguments: {
        status: "escalate",
        violations: [],
        conflicts: ["authority conflict"],
        decisionGate: { question: "Which authority?", options: ["A", "B"] },
      },
    },
  ];

  for (const [index, candidate] of cases.entries()) {
    await withPersistedSession(async (sessionManager) => {
      const nested = response(
        `valid-${index}`,
        [
          { type: "text", text: "structured audit response" },
          fauxToolCall(decisionToolName, candidate.arguments, { id: `call-${index}` }),
        ],
        {
          diagnostics: [
            {
              type: "provider-diagnostic",
              timestamp: 10,
              error: { message: "retained diagnostic" },
            },
          ],
        },
      );
      const decision = await audit(nested, sessionManager);
      assert.equal(decision.status, candidate.status);

      const persisted = persistedResponse(sessionManager, `valid-${index}`);
      assert.deepEqual(
        JSON.parse(JSON.stringify(persisted)),
        JSON.parse(JSON.stringify(nested)),
      );
      assert.equal(
        sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.responseId === `valid-${index}`),
        false,
      );
    });
  }
});

test("transport accepts known statuses and retains unreadable object status as residual", async () => {
  const acceptedArguments = [
    { status: "pass", conflicts: ["non-neutral bookkeeping"], auditCost: 3 },
    { status: "revise" },
    { status: "escalate", conflicts: ["provider conflict"], decisionGate: "provider-shaped bookkeeping" },
  ];
  for (const [index, arguments_] of acceptedArguments.entries()) {
    await withPersistedSession(async (sessionManager) => {
      const result = await audit(
        response(`open-status-${index}`, [fauxToolCall(decisionToolName, arguments_)]),
        sessionManager,
      );
      assert.equal(result.status, arguments_.status);
      if (arguments_.status === "escalate" && result.status === "escalate") {
        assert.deepEqual(result.conflicts, arguments_.conflicts);
        assert.equal(result.decisionGate, arguments_.decisionGate);
      }
    });
  }
  for (const [id, arguments_] of [[
    "unknown-status",
    { status: "unknown", auditCost: 3 },
  ], ["missing-status", {}]] as const) {
    await withPersistedSession(async (sessionManager) => {
      const result = await audit(
        response(id, [fauxToolCall(decisionToolName, arguments_)]),
        sessionManager,
      );
      assert.equal(result.status, "audit-incomplete");
      if (result.status === "audit-incomplete") {
        assert.deepEqual(result.candidate, arguments_);
        assert.deepEqual(result.observation, {
          kind: "object-status-unreadable",
          status: id === "missing-status" ? "missing" : "unknown",
        });
      }
    });
  }
});

test("known escalate keeps disposition and raw ancillary fields", async () => {
  const cases = [
    { status: "escalate", decisionGate: { question: "Q", options: ["A"] } },
    { status: "escalate", conflicts: ["c"] },
    { status: "escalate", conflicts: ["c"], decisionGate: "not-a-gate" },
    { status: "escalate", conflicts: "not-a-list", decisionGate: null },
  ] as const;
  for (const [index, candidate] of cases.entries()) {
    await withPersistedSession(async (sessionManager) => {
      const result = await audit(
        response(`escalate-raw-${index}`, [fauxToolCall(decisionToolName, candidate)]),
        sessionManager,
      );
      assert.equal(result.status, "escalate");
      if (result.status !== "escalate") return;
      assert.equal(Object.hasOwn(result, "conflicts"), Object.hasOwn(candidate, "conflicts"));
      assert.equal(Object.hasOwn(result, "decisionGate"), Object.hasOwn(candidate, "decisionGate"));
      const rawCandidate = candidate as Record<string, unknown>;
      if (Object.hasOwn(rawCandidate, "conflicts")) assert.deepEqual(result.conflicts, rawCandidate.conflicts);
      if (Object.hasOwn(rawCandidate, "decisionGate")) assert.deepEqual(result.decisionGate, rawCandidate.decisionGate);
      assert.deepEqual(
        (persistedResponse(sessionManager, `escalate-raw-${index}`).content[0] as { arguments?: unknown }).arguments,
        candidate,
      );
    });
  }
});

test("successful non-object decision arguments retain a typed residual without aborting", async () => {
  const cases: Array<{ id: string; arguments: unknown }> = [
    { id: "non-object-null", arguments: null },
    { id: "non-object-array", arguments: ["provider candidate"] },
    { id: "non-object-primitive", arguments: "provider candidate" },
  ];

  for (const candidate of cases) {
    await withPersistedSession(async (sessionManager) => {
      const nested = response(candidate.id, [
        fauxToolCall(
          decisionToolName,
          candidate.arguments as Record<string, unknown>,
        ),
      ]);
      const decision = await audit(nested, sessionManager);

      assert.equal(decision.status, "audit-incomplete");
      if (decision.status !== "audit-incomplete") return;
      assert.deepEqual(decision.observation, {
        kind: "non-object-arguments",
        type: candidate.arguments === null
          ? "null"
          : Array.isArray(candidate.arguments)
            ? "array"
            : typeof candidate.arguments,
      });
      assert.deepEqual(decision.candidate, candidate.arguments);
      assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE).length, 1);
      assert.deepEqual(
        JSON.parse(JSON.stringify(persistedResponse(sessionManager, candidate.id))),
        JSON.parse(JSON.stringify(nested)),
        `${candidate.id} raw response/candidate must survive the residual path`,
      );
      assert.equal(
        sessionManager.getEntries().some((entry) => entry.type === "message"),
        false,
        `${candidate.id} must not create an accepted receipt`,
      );
    });
  }
});

test("malformed nested decisions retain raw responses and report typed facts", async () => {
  const cases = [
    {
      id: "terminal-error-with-valid-call",
      content: [
        fauxToolCall(decisionToolName, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ],
      stopReason: "error" as const,
      errorMessage: "provider rejected the decision",
      expectedCount: 1,
      expectedNames: [decisionToolName],
      errorPresent: true,
    },
    {
      id: "terminal-aborted-with-valid-call",
      content: [
        fauxToolCall(decisionToolName, { status: "revise", violations: ["native abort"], conflicts: [], decisionGate: null }),
      ],
      stopReason: "aborted" as const,
      errorMessage: "provider aborted the decision",
      expectedCount: 1,
      expectedNames: [decisionToolName],
      errorPresent: true,
    },
    {
      id: "zero-calls",
      content: [{ type: "text" as const, text: "no decision" }],
      stopReason: "error" as const,
      errorMessage: "provider rejected the decision",
      expectedCount: 0,
      expectedNames: [],
      errorPresent: true,
    },
    {
      id: "wrong-name",
      content: [fauxToolCall("ak_other_decision", { status: "pass", violations: [], conflicts: [], decisionGate: null })],
      stopReason: "stop" as const,
      expectedCount: 1,
      expectedNames: ["ak_other_decision"],
      errorPresent: false,
    },
    {
      id: "malformed-arguments",
      content: [
        fauxToolCall(decisionToolName, {
          status: "pass",
          violations: ["pass must be empty"],
          conflicts: [],
          decisionGate: null,
        }),
      ],
      stopReason: "error" as const,
      diagnostics: [
        {
          type: "schema-diagnostic",
          timestamp: 11,
          details: { source: "test" },
        },
      ],
      expectedCount: 1,
      expectedNames: [decisionToolName],
      errorPresent: true,
    },
  ];

  for (const candidate of cases) {
    await withPersistedSession(async (sessionManager) => {
      const nested = response(candidate.id, candidate.content, {
        stopReason: candidate.stopReason,
        ...(candidate.errorMessage === undefined
          ? {}
          : { errorMessage: candidate.errorMessage }),
        ...(candidate.diagnostics === undefined
          ? {}
          : { diagnostics: candidate.diagnostics }),
      });
      let thrown: unknown;
      try {
        await audit(nested, sessionManager);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof Error);
      assert.equal(thrown.name, "ComplianceDecisionContractError");
      assert.deepEqual(diagnosticFacts(thrown), {
        expectedDecisionToolName: decisionToolName,
        observedToolCallCount: candidate.expectedCount,
        observedToolNames: candidate.expectedNames,
        responseStopReason: candidate.stopReason,
        provider: "faux",
        model: "faux-1",
        responseModel: "audit-response-model",
        errorMessage: candidate.errorMessage ?? null,
        diagnostics: candidate.diagnostics ?? [],
      });

      const persisted = persistedResponse(sessionManager, candidate.id);
      assert.deepEqual(
        JSON.parse(JSON.stringify(persisted)),
        JSON.parse(JSON.stringify(nested)),
        `${candidate.id} raw response must survive malformed parsing`,
      );
      assert.equal(
        sessionManager.getEntries().some(
          (entry) => entry.type === "message" && entry.message.role === "toolResult",
        ),
        false,
        `${candidate.id} must not append a toolResult for the rejected nested decision`,
      );
    });
  }
});

test("nested response retention failures are explicit and cause-preserving", async () => {
  const cause = new Error("session append failed");
  await assert.rejects(
    audit(
      response("retention-failure", [{ type: "text", text: "provider response" }]),
      { appendCustomEntry() { throw cause; } } as unknown as SessionManager,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ComplianceResponseRetentionError");
      assert.equal(error.cause, cause);
      return true;
    },
  );
  await assert.rejects(
    audit(
      response("retention-unavailable", [{ type: "text", text: "provider response" }]),
      {} as SessionManager,
    ),
    (error: unknown) => error instanceof Error && error.name === "ComplianceResponseRetentionError",
  );
});

test("a provider throw without an AssistantMessage preserves its original cause", async () => {
  await withPersistedSession(async (sessionManager) => {
    const existing = response("existing", [{ type: "text", text: "outer response" }]);
    sessionManager.appendMessage(existing);
    const cause = new Error("stream disconnected before a response");
    const failure = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      runCompletion: async () => {
        throw cause;
      },
      context: context(sessionManager),
    });

    await assert.rejects(failure, (error: unknown) => {
      assert.strictEqual(error, cause);
      return true;
    });
    assert.deepEqual(
      sessionManager.getEntries().flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant"
          ? [entry.message.responseId]
          : []
      ),
      ["existing"],
    );
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile);
    const raw = await readFile(sessionFile, "utf8");
    assert.equal(raw.includes("stream disconnected before a response"), false);
  });
});

async function advanceIdleAttempts(
  t: { mock: { timers: { tick(ms: number): void } } },
  attempts: number,
  idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(idleTimeoutMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("default body idle silence budget is owner-final 183s and distinct from header timeout wiring", () => {
  assert.equal(DEFAULT_STREAM_IDLE_TIMEOUT_MS, 183_000);
  assert.equal(DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES, 2);
});

test("silent compliance completion exhausts idle retries as typed infrastructure failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    const seen: { options?: Record<string, unknown>; attempts: number } = { attempts: 0 };
    const auditContext = defaultCompletionContext(
      sessionManager,
      (options) => {
        seen.attempts += 1;
        return new Promise<AssistantMessage>((_resolve, reject) => {
          const signal = options.signal;
          if (!(signal instanceof AbortSignal)) return;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      seen,
    );
    const started = Date.now();
    const assertion = assert.rejects(
      runComplianceAudit({
        tool: decisionTool,
        systemPrompt: "audit system",
        serializedInput: "audit input",
        roleLabel: "Compliance",
        invalidDecisionLabel: "invalid compliance decision",
        context: auditContext,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StreamIdleTimeoutError);
        assert.equal(error.code, "AK_STREAM_IDLE_TIMEOUT");
        assert.equal(error.idleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
        return true;
      },
    );
    await advanceIdleAttempts(t, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
    await assertion;
    assert.ok(Date.now() - started < 1000);
    assert.equal(seen.attempts, DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES + 1);
    assert.equal(seen.options?.timeoutMs, 183000);
    assert.equal(
      sessionManager.getEntries().some((entry) =>
        entry.type === "custom" && entry.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE),
      false,
    );
    assert.equal(
      sessionManager.getEntries().some((entry) => entry.type === "message"),
      false,
    );
  });
});

test("compliance dispatch keeps one object-root tool across every supported API", async () => {
  const expectedToolChoices: Record<string, unknown> = {
    "anthropic-messages": undefined,
    "bedrock-converse-stream": undefined,
    "mistral-conversations": { type: "function", function: { name: decisionToolName } },
    "openai-completions": { type: "function", function: { name: decisionToolName } },
    "pi-messages": { type: "function", function: { name: decisionToolName } },
    "azure-openai-responses": { type: "function", name: decisionToolName },
    "openai-responses": { type: "function", name: decisionToolName },
    "google-generative-ai": "any",
    "google-vertex": "any",
    "openai-codex-responses": "required",
    default: "required",
  };
  for (const api of Object.keys(expectedToolChoices)) {
    await withPersistedSession(async (sessionManager) => {
      const base = context(sessionManager);
      const seen: { model?: string; request?: Record<string, unknown>; context?: Context } = {};
      const auditContext = {
        ...base,
        model: { ...(base.model as object), api: api === "default" ? "future-api" : api },
      };
      const result = await runComplianceAudit({
        tool: decisionTool,
        systemPrompt: "audit system",
        serializedInput: "audit input",
        roleLabel: "Compliance",
        invalidDecisionLabel: "invalid compliance decision",
        context: {
          ...auditContext,
          modelRegistry: {
            ...(base.modelRegistry as object),
            getProviderAuth: async () => ({ auth: { apiKey: "test-secret" } }),
            getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-secret" }),
          },
        } as unknown as ExtensionContext,
        runCompletion: async (model, requestContext, request) => {
          seen.model = model.api;
          seen.context = requestContext;
          seen.request = request;
          return response(`dispatch-${api}`, [fauxToolCall(decisionToolName, { status: "pass" })]);
        },
      });
      assert.equal(result.status, "pass");
      assert.equal((seen.context?.tools?.[0]?.parameters as { type?: unknown } | undefined)?.type, "object");
      assert.deepEqual(seen.request?.toolChoice, expectedToolChoices[api]);
      assert.equal(api !== "default" && api.includes("openai"), typeof seen.request?.onPayload === "function");
    });
  }
});

test("payload and response-header hooks do not extend the first body-event silence budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    const base = context(sessionManager);
    const hooks: { payload: number; response: number } = { payload: 0, response: 0 };
    const silenceBudgetMs = 200_000;
    const auditContext = {
      ...base,
      modelRegistry: {
        ...(base.modelRegistry as object),
        getProvider() {
          return {
            stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
              const signal = options.signal;
              return {
                async *[Symbol.asyncIterator]() {
                  // Late outbound/header activity must not reset the first-event silence clock.
                  await new Promise<void>((resolve) => setTimeout(resolve, 150_000));
                  const onPayload = options.onPayload;
                  if (typeof onPayload === "function") {
                    hooks.payload += 1;
                    await onPayload({ tools: [] }, { api: "openai-responses" });
                  }
                  const onResponse = options.onResponse;
                  if (typeof onResponse === "function") {
                    hooks.response += 1;
                    await onResponse({ status: 200, headers: {} }, { api: "openai-responses" });
                  }
                  await new Promise<never>((_resolve, reject) => {
                    if (!(signal instanceof AbortSignal)) return;
                    if (signal.aborted) {
                      reject(signal.reason);
                      return;
                    }
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  });
                },
                result: async () => {
                  throw new Error("idle must abort before stream.result");
                },
              };
            },
          };
        },
      },
    } as unknown as ExtensionContext;

    const failure = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: auditContext,
      idleTimeoutMs: silenceBudgetMs,
      idleMaxRetries: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(150_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(hooks.payload, 1);
    // Production no longer installs onResponse; even if a provider called one, it must not poke.
    assert.equal(hooks.response, 0);
    t.mock.timers.tick(50_000);
    await assert.rejects(
      failure,
      (error: unknown) => {
        assert.ok(error instanceof StreamIdleTimeoutError);
        assert.equal(error.idleTimeoutMs, silenceBudgetMs);
        return true;
      },
    );
    assert.equal(
      sessionManager.getEntries().some((entry) =>
        entry.type === "custom" && entry.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE),
      false,
    );
  });
});

test("after one real body event, a full idle silence budget aborts without a receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    const base = context(sessionManager);
    const auditContext = {
      ...base,
      modelRegistry: {
        ...(base.modelRegistry as object),
        getProvider() {
          return {
            stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
              const signal = options.signal;
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: "text_delta", delta: "first" };
                  await new Promise<never>((_resolve, reject) => {
                    if (!(signal instanceof AbortSignal)) return;
                    if (signal.aborted) {
                      reject(signal.reason);
                      return;
                    }
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  });
                },
                result: async () => {
                  throw new Error("idle must abort before stream.result");
                },
              };
            },
          };
        },
      },
    } as unknown as ExtensionContext;

    const failure = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: auditContext,
      idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      idleMaxRetries: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Allow the first body event to poke, then enforce a fresh full silence budget.
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    await assert.rejects(
      failure,
      (error: unknown) => {
        assert.ok(error instanceof StreamIdleTimeoutError);
        assert.equal(error.code, "AK_STREAM_IDLE_TIMEOUT");
        assert.equal(error.idleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
        return true;
      },
    );
    assert.equal(
      sessionManager.getEntries().some((entry) =>
        entry.type === "custom" && entry.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE),
      false,
    );
    assert.equal(
      sessionManager.getEntries().some((entry) => entry.type === "message"),
      false,
    );
  });
});

test("default stream iterator events poke idle so body silence is bounded without a total wall clock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    const base = context(sessionManager);
    // Gaps stay under the 183s idle budget while total wall exceeds 183s.
    const gapMs = 150_000;
    const auditContext = {
      ...base,
      modelRegistry: {
        ...(base.modelRegistry as object),
        getProvider() {
          return {
            stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
              const signal = options.signal;
              return {
                async *[Symbol.asyncIterator]() {
                  for (let i = 0; i < 3; i += 1) {
                    await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
                    if (signal instanceof AbortSignal && signal.aborted) {
                      throw signal.reason;
                    }
                    yield { type: "text_delta", delta: "chunk" };
                  }
                },
                result: async () => {
                  if (signal instanceof AbortSignal && signal.aborted) throw signal.reason;
                  return response("stream-idle-healthy", [
                    fauxToolCall(decisionToolName, {
                      status: "pass",
                      violations: [],
                      conflicts: [],
                      decisionGate: null,
                    }),
                  ]);
                },
              };
            },
          };
        },
      },
    } as unknown as ExtensionContext;

    const pending = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: auditContext,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 0; i < 3; i += 1) {
      t.mock.timers.tick(gapMs);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const decision = await pending;
    assert.equal(decision.status, "pass");
    assert.ok(gapMs * 3 > DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });
});

test("first silent hang aborts then the next idle attempt starts with a fresh signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    const signals: AbortSignal[] = [];
    const auditContext = defaultCompletionContext(
      sessionManager,
      (options) => {
        const signal = options.signal;
        assert.ok(signal instanceof AbortSignal);
        signals.push(signal);
        return new Promise<AssistantMessage>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      {},
    );
    const assertion = assert.rejects(
      runComplianceAudit({
        tool: decisionTool,
        systemPrompt: "audit system",
        serializedInput: "audit input",
        roleLabel: "Compliance",
        invalidDecisionLabel: "invalid compliance decision",
        context: auditContext,
        idleTimeoutMs: 5_000,
        idleMaxRetries: 1,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StreamIdleTimeoutError);
        assert.equal(error.idleTimeoutMs, 5_000);
        return true;
      },
    );
    await advanceIdleAttempts(t, 1, 5_000);
    assert.equal(signals.length, 2);
    assert.notStrictEqual(signals[0], signals[1]);
    assert.equal(signals[0]?.aborted, true);
    await advanceIdleAttempts(t, 1, 5_000);
    await assertion;
  });
});

test("healthy idle retry succeeds without forging a compliance receipt on the failed attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPersistedSession(async (sessionManager) => {
    let attempts = 0;
    const auditContext = defaultCompletionContext(
      sessionManager,
      (options) => {
        attempts += 1;
        if (attempts === 1) {
          return new Promise<AssistantMessage>((_resolve, reject) => {
            const signal = options.signal;
            if (!(signal instanceof AbortSignal)) return;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return Promise.resolve(response("idle-retry-healthy", [
          fauxToolCall(decisionToolName, {
            status: "pass",
            violations: [],
            conflicts: [],
            decisionGate: null,
          }),
        ]));
      },
      {},
    );
    const pending = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: auditContext,
      idleTimeoutMs: 5_000,
      idleMaxRetries: 1,
    });
    await advanceIdleAttempts(t, 1, 5_000);
    const decision = await pending;
    assert.equal(decision.status, "pass");
    assert.equal(attempts, 2);
    assert.equal(persistedResponse(sessionManager, "idle-retry-healthy").responseId, "idle-retry-healthy");
    assert.equal(
      sessionManager.getEntries().filter((entry) =>
        entry.type === "custom" && entry.customType === COMPLIANCE_RESPONSE_ENTRY_TYPE).length,
      1,
    );
  });
});

test("parent abort still wins over the idle guard on the compliance seam", async () => {
  await withPersistedSession(async (sessionManager) => {
    const parent = new AbortController();
    const parentReason = new Error("parent cancelled compliance");
    const failure = runComplianceAudit({
      tool: decisionTool,
      systemPrompt: "audit system",
      serializedInput: "audit input",
      roleLabel: "Compliance",
      invalidDecisionLabel: "invalid compliance decision",
      context: defaultCompletionContext(
        sessionManager,
        (options) => new Promise<AssistantMessage>((_resolve, reject) => {
          const signal = options.signal;
          if (!(signal instanceof AbortSignal)) return;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        {},
      ),
      signal: parent.signal,
      idleTimeoutMs: 183_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    parent.abort(parentReason);
    await assert.rejects(failure, (error: unknown) => {
      assert.strictEqual(error, parentReason);
      return true;
    });
  });
});
