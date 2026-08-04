import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  COMPLIANCE_RESPONSE_ENTRY_TYPE,
  ComplianceDecisionContractError,
  complianceDecisionSchema,
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

test("default compliance completion sends the production timeout and preserves signal pass-through", async () => {
  await withPersistedSession(async (sessionManager) => {
    const seen: { options?: Record<string, unknown> } = {};
    const signal = new AbortController().signal;
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
      signal,
    });
    assert.equal(decision.status, "pass");
    assert.equal(seen.options?.timeoutMs, 183000);
    assert.strictEqual(seen.options?.signal, signal);
    assert.deepEqual(Object.keys(seen.options ?? {}).sort(), [
      "apiKey", "cacheRetention", "maxTokens", "onPayload", "sessionId", "signal", "timeoutMs", "toolChoice",
    ]);
  });
});

test("a timeout-honoring provider terminates the real default seam with typed cause and no receipt", async () => {
  await withPersistedSession(async (sessionManager) => {
    const seen: { options?: Record<string, unknown> } = {};
    const auditContext = defaultCompletionContext(
      sessionManager,
      (options) => new Promise<AssistantMessage>((resolve) => {
        // This provider models the registry timeout seam with a short threshold;
        // without timeoutMs it remains pending rather than fabricating failure.
        if (typeof options.timeoutMs !== "number" || options.timeoutMs <= 0) return;
        // The provider honors the configured deadline, bounded to a short test
        // threshold so this regression test never sleeps for 183 seconds.
        setTimeout(() => resolve(response("default-timeout", [], {
          stopReason: "error",
          errorMessage: "provider timeout: compliance request expired",
        })), Math.min(options.timeoutMs, 10));
      }),
      seen,
    );
    const started = Date.now();
    await assert.rejects(
      runComplianceAudit({
        tool: decisionTool,
        systemPrompt: "audit system",
        serializedInput: "audit input",
        roleLabel: "Compliance",
        invalidDecisionLabel: "invalid compliance decision",
        context: auditContext,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ComplianceDecisionContractError);
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

test("Codex decision schema is an object with every property required", () => {
  assert.equal(complianceDecisionSchema.type, "object");
  assert.equal((complianceDecisionSchema as { anyOf?: unknown }).anyOf, undefined);
  assert.deepEqual(
    complianceDecisionSchema.required,
    Object.keys(complianceDecisionSchema.properties),
  );
  assert.deepEqual(Object.keys(complianceDecisionSchema.properties), [
    "status",
    "violations",
    "conflicts",
    "decisionGate",
  ]);
});

test("status-dependent decision combinations are validated at the shared parser seam", async () => {
  const invalidArguments = [
    { status: "pass", violations: [], conflicts: ["unexpected"], decisionGate: null },
    { status: "pass", violations: [], conflicts: [], decisionGate: { question: "Choose", options: ["A"] } },
    { status: "pass", violations: ["unexpected"], conflicts: [], decisionGate: null },
    { status: "revise", violations: [], conflicts: [], decisionGate: null },
    { status: "revise", violations: ["real"], conflicts: ["unexpected"], decisionGate: null },
    { status: "revise", violations: ["real"], conflicts: [], decisionGate: { question: "Choose", options: ["A"] } },
    { status: "escalate", violations: [], conflicts: [], decisionGate: { question: "Choose", options: ["A"] } },
    { status: "escalate", violations: ["unexpected"], conflicts: ["conflict"], decisionGate: { question: "Choose", options: ["A"] } },
    { status: "escalate", violations: [], conflicts: ["conflict"], decisionGate: null },
    { status: "pass" },
  ];

  for (const [index, arguments_] of invalidArguments.entries()) {
    await withPersistedSession(async (sessionManager) => {
      await assert.rejects(
        audit(
          response(`invalid-status-${index}`, [
            fauxToolCall(decisionToolName, arguments_),
          ]),
          sessionManager,
        ),
        (error: unknown) => error instanceof Error && error.name === "ComplianceDecisionContractError",
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
      id: "multiple-calls",
      content: [
        fauxToolCall(decisionToolName, { status: "pass", violations: [], conflicts: [], decisionGate: null }),
        fauxToolCall("ak_other_decision", { status: "pass", violations: [], conflicts: [], decisionGate: null }),
      ],
      stopReason: "toolUse" as const,
      expectedCount: 2,
      expectedNames: [decisionToolName, "ak_other_decision"],
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
