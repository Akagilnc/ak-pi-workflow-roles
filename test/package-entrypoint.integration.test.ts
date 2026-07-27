import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { JUDGE_OUTPUT_TOOL_NAME } from "../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../src/soul-auditor.ts";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const siblingTool = defineTool({
  name: "integration_sibling",
  label: "Integration Sibling",
  description: "Offline sibling used to exercise Pi's parallel tool lifecycle",
  parameters: Type.Object({}),
  async execute() {
    await Promise.resolve();
    return {
      content: [{ type: "text" as const, text: "sibling completed" }],
      details: {},
    };
  },
});

function textOf(message: ToolResultMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function packageEntrypoint(manifest: {
  files?: string[];
  pi?: { extensions?: string[] };
}): string {
  assert.ok(manifest.files?.includes("extensions"));
  assert.ok(manifest.files?.includes("souls"));
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/role-runtime.ts"]);
  return resolve(packageRoot, manifest.pi.extensions[0]!);
}

test("packaged judge crosses Pi's loader, schema, persisted batch, auth-resolved audit, and termination boundaries offline", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[]; pi?: { extensions?: string[] } };
  const judgeSoul = (await readFile(resolve(packageRoot, "souls/judge.md"), "utf8")).trim();
  const agentDir = await mkdtemp(resolve(tmpdir(), "ak-role-integration-"));
  const faux = fauxProvider({
    api: "ak-role-offline",
    provider: "ak-role-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const defaultBaseUrl = "https://default.invalid/v1";
  const resolvedBaseUrl = "https://tenant.invalid/v1";
  const activeModel = { ...faux.getModel(), baseUrl: defaultBaseUrl };
  const authResolvedProvider = {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Integration resolved authentication",
        async resolve() {
          return {
            auth: {
              apiKey: "resolved-secret",
              headers: { "x-resolved-auth": "yes" },
              baseUrl: resolvedBaseUrl,
            },
            env: { RESOLVED_TENANT: "integration" },
          };
        },
      },
    },
    getModels() {
      return [activeModel];
    },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(authResolvedProvider);

  const loader = new DefaultResourceLoader({
    cwd: packageRoot,
    agentDir,
    additionalExtensionPaths: [packageEntrypoint(manifest)],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "INTEGRATION BASE PROMPT",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const sessionManager = SessionManager.inMemory(packageRoot);
  const { session, extensionsResult } = await createAgentSession({
    cwd: packageRoot,
    agentDir,
    model: activeModel,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    noTools: "builtin",
    customTools: [siblingTool],
    thinkingLevel: "off",
  });

  const lifecycle: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      lifecycle.push(`start:${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      lifecycle.push(`end:${event.toolName}:${event.isError ? "error" : "ok"}`);
    }
  });

  try {
    assert.equal(extensionsResult.extensions.length, 1);
    session.extensionRunner.setFlagValue("ak-role", "judge");
    await session.bindExtensions({ mode: "print" });
    assert.ok(
      session.agent.state.tools.some((tool) => tool.name === JUDGE_OUTPUT_TOOL_NAME),
      "session_start dynamically registers the packaged judge tool",
    );

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          JUDGE_OUTPUT_TOOL_NAME,
          { judgeStatus: "converged", unexpected: true },
          { id: "schema-invalid" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("schema rejection observed"),
    ]);
    await session.prompt("Exercise provider-facing schema validation.");

    const schemaResult = sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "schema-invalid",
      );
    assert.ok(schemaResult?.type === "message");
    assert.equal(schemaResult.message.role, "toolResult");
    assert.equal(schemaResult.message.isError, true);
    assert.match(textOf(schemaResult.message), /unexpected|additional propert/i);
    assert.equal(faux.state.callCount, 2, "schema rejection never invokes the audit model");

    lifecycle.length = 0;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            JUDGE_OUTPUT_TOOL_NAME,
            { judgeStatus: "converged" },
            { id: "parallel-judge" },
          ),
          fauxToolCall("integration_sibling", {}, { id: "parallel-sibling" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("parallel rejection observed"),
    ]);
    await session.prompt("Exercise a parallel sibling call.");

    const parallelAssistant = sessionManager.getEntries().find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some(
          (part) => part.type === "toolCall" && part.id === "parallel-judge",
        ),
    );
    assert.ok(parallelAssistant?.type === "message");
    assert.equal(parallelAssistant.message.role, "assistant");
    assert.deepEqual(
      parallelAssistant.message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => part.id),
      ["parallel-judge", "parallel-sibling"],
      "Pi persists the complete assistant batch before tool execution",
    );

    const parallelResults: ToolResultMessage[] = [];
    for (const entry of sessionManager.getEntries()) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        ["parallel-judge", "parallel-sibling"].includes(
          entry.message.toolCallId,
        )
      ) {
        parallelResults.push(entry.message);
      }
    }
    assert.equal(parallelResults.length, 2);
    assert.match(textOf(parallelResults[0]!), /sole final tool call/);
    assert.equal(parallelResults[0]!.isError, true);
    assert.equal(parallelResults[1]!.isError, false);
    assert.deepEqual(lifecycle.slice(0, 2), [
      `start:${JUDGE_OUTPUT_TOOL_NAME}`,
      "start:integration_sibling",
    ]);
    assert.equal(faux.state.callCount, 4, "sibling rejection never invokes the audit model");

    let judgeContext: Context | undefined;
    let auditContext: Context | undefined;
    let auditDispatch:
      | {
          baseUrl: string | undefined;
          apiKey: string | undefined;
          headers: Record<string, string | null> | undefined;
          env: Record<string, string> | undefined;
        }
      | undefined;
    faux.setResponses([
      (context) => {
        judgeContext = context;
        return fauxAssistantMessage(
          fauxToolCall(
            JUDGE_OUTPUT_TOOL_NAME,
            { judgeStatus: "converged" },
            { id: "accepted-judge" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context, requestOptions, _state, requestModel) => {
        auditContext = context;
        auditDispatch = {
          baseUrl: requestModel.baseUrl,
          apiKey: requestOptions?.apiKey,
          headers: requestOptions?.headers,
          env: requestOptions?.env,
        };
        return fauxAssistantMessage(
          fauxToolCall(
            SOUL_AUDIT_TOOL_NAME,
            { status: "pass", violations: [] },
            { id: "audit-pass" },
          ),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await session.prompt("Exercise audited terminating acceptance.");

    const seenJudgeContext = judgeContext as Context | undefined;
    assert.ok(seenJudgeContext);
    assert.ok(
      seenJudgeContext.systemPrompt?.includes(
        `<judge_soul>\n${judgeSoul}\n</judge_soul>`,
      ),
      "the provider receives the complete bundled judge Soul",
    );
    const seenAuditContext = auditContext as Context | undefined;
    assert.ok(seenAuditContext);
    assert.notEqual(activeModel.baseUrl, resolvedBaseUrl);
    assert.deepEqual(auditDispatch, {
      baseUrl: resolvedBaseUrl,
      apiKey: "resolved-secret",
      headers: { "x-resolved-auth": "yes" },
      env: { RESOLVED_TENANT: "integration" },
    });
    const auditInput = seenAuditContext.messages.find(
      (message) => message.role === "user",
    );
    assert.ok(auditInput?.role === "user");
    const auditContent =
      typeof auditInput.content === "string"
        ? [{ type: "text" as const, text: auditInput.content }]
        : auditInput.content;
    const auditText = auditContent
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.ok(auditText.includes(`<judge_soul>\n${judgeSoul}\n</judge_soul>`));

    const acceptedResult = sessionManager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "accepted-judge",
      );
    assert.ok(acceptedResult?.type === "message");
    assert.equal(acceptedResult.message.role, "toolResult");
    assert.equal(acceptedResult.message.isError, false);
    assert.deepEqual(acceptedResult.message.details, { judgeStatus: "converged" });
    assert.equal(faux.state.callCount, 6);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(
      sessionManager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.content.some(
              (part) => part.type === "toolCall" && part.id === "accepted-judge",
            ),
        ).length,
      1,
      "terminate ends the real Pi lifecycle without a follow-up provider turn",
    );
  } finally {
    unsubscribe();
    session.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
