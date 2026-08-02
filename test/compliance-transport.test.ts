import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
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
  complianceDecisionSchema,
  createComplianceDecisionTool,
  runComplianceAudit,
} from "../src/compliance-transport.ts";

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

async function persistedAssistant(
  sessionManager: SessionManager,
  responseId: string,
): Promise<Record<string, unknown>> {
  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  const entries = (await readFile(sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const entry = entries.find((candidate) => {
    const message = candidate.message;
    return (
      candidate.type === "message" &&
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).responseId === responseId
    );
  });
  assert.ok(entry);
  return entry;
}

async function withPersistedSession<T>(
  callback: (sessionManager: SessionManager) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(resolve("/tmp", "ak-compliance-transport-"));
  try {
    return await callback(SessionManager.create(root, resolve(root, "sessions")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  const jsonStart = error.message.indexOf("{");
  assert.notEqual(jsonStart, -1, error.message);
  return JSON.parse(error.message.slice(jsonStart)) as Record<string, unknown>;
}

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

      const entry = await persistedAssistant(sessionManager, `valid-${index}`);
      assert.deepEqual(
        (entry.message as unknown),
        JSON.parse(JSON.stringify(nested)),
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
        /invalid compliance decision: arguments do not match/,
      );
    });
  }
});

test("malformed nested decisions retain raw responses and report typed facts", async () => {
  const cases = [
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
      assert.match(thrown.message, /invalid compliance decision/);
      assert.deepEqual(diagnosticFacts(thrown), {
        expectedDecisionToolName: decisionToolName,
        observedToolCallCount: candidate.expectedCount,
        observedToolNames: candidate.expectedNames,
        responseStopReason: candidate.stopReason,
        errorMessageOrDiagnosticPresent: candidate.errorPresent,
      });

      const entry = await persistedAssistant(sessionManager, candidate.id);
      assert.deepEqual(
        entry.message,
        JSON.parse(JSON.stringify(nested)),
        `${candidate.id} raw response must survive malformed parsing`,
      );
    });
  }
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
