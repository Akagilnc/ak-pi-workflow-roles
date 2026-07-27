import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

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
  parseSkillBlock,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
} from "../src/role-runtime.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../src/soul-auditor.ts";
import { writeTestSkill } from "./helpers/test-skill.ts";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const execFileAsync = promisify(execFile);
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

test("packaged CLI help exposes all four roles and Reviewer task input", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[]; pi?: { extensions?: string[] } };
  const { stdout } = await execFileAsync(
    resolve(packageRoot, "node_modules/.bin/pi"),
    ["--no-extensions", "-e", packageEntrypoint(manifest), "--help"],
    { cwd: packageRoot },
  );
  assert.match(stdout, /--ak-role <value>\s+Activate a packaged workflow role: judge, fixer, coder, or reviewer/);
  assert.match(stdout, /--ak-review-task <value>\s+Opaque Markdown review task assigned to the reviewer role/);
});

test("packaged CLI help exposes the complete fixer phase contract", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[]; pi?: { extensions?: string[] } };
  const { stdout } = await execFileAsync(
    resolve(packageRoot, "node_modules/.bin/pi"),
    [
      "--no-extensions",
      "-e",
      packageEntrypoint(manifest),
      "--ak-role",
      "fixer",
      "--help",
    ],
    { cwd: packageRoot },
  );
  const extensionHelp = stdout.match(
    /Extension CLI Flags:\n([\s\S]*?)\n\nExamples:/,
  )?.[1];

  assert.ok(extensionHelp, "Pi renders extension CLI flags");
  assert.match(
    extensionHelp,
    /--ak-fixer-phase <value>\s+Fixer phase: plan \(inspect and propose a repair plan; no edits or commits\) or apply \(execute the approved plan, verify, and commit when repaired\)/,
  );
});

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
  const modelsPath = resolve(agentDir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        [activeModel.provider]: {
          modelOverrides: {
            [activeModel.id]: {
              headers: { "x-model-route": "audit-tenant" },
            },
          },
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath,
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

  try {
    assert.equal(extensionsResult.extensions.length, 1);
    session.extensionRunner.setFlagValue("ak-role", "judge");
    await session.bindExtensions({ mode: "print" });
    assert.deepEqual(
      session.agent.state.tools.map((tool) => tool.name),
      ["read", "grep", "find", "ls", "bash", JUDGE_OUTPUT_TOOL_NAME],
      "Judge activation keeps exactly the registered evidence tools and output",
    );
    assert.equal(
      session.agent.state.tools.some((tool) =>
        ["write", "edit", "integration_sibling"].includes(tool.name),
      ),
      false,
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
      headers: {
        "x-resolved-auth": "yes",
        "x-model-route": "audit-tenant",
      },
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
    assert.equal(faux.state.callCount, 4);
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
    session.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("packaged coder apply proves the immediately following canonical native tdd expansion", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[]; pi?: { extensions?: string[] } };
  const coderSoul = (await readFile(resolve(packageRoot, "souls/coder.md"), "utf8")).trim();
  const agentDir = await mkdtemp(resolve(tmpdir(), "ak-coder-integration-"));
  const previousHome = process.env.HOME;
  process.env.HOME = agentDir;
  const { path: tddSkillTargetPath, raw: tddSkillRaw } = await writeTestSkill(
    resolve(agentDir, "owned-target"),
    "tdd",
  );
  const tddSkillPath = resolve(agentDir, ".agents/skills/tdd/SKILL.md");
  await mkdir(dirname(tddSkillPath), { recursive: true });
  await symlink(tddSkillTargetPath, tddSkillPath);
  const taskPath = resolve(agentDir, "approved-task.md");
  const task = "# Approved task\n\nImplement the first vertical slice.";
  await writeFile(taskPath, task);
  const faux = fauxProvider({
    api: "ak-coder-offline",
    provider: "ak-coder-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const activeModel = faux.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: resolve(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Coder integration auth",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: packageRoot,
    agentDir,
    additionalExtensionPaths: [packageEntrypoint(manifest)],
    additionalSkillPaths: [tddSkillPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "CODER INTEGRATION BASE PROMPT",
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(packageRoot);
  const { session } = await createAgentSession({
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
    customTools: [siblingTool],
    thinkingLevel: "off",
  });

  try {
    session.extensionRunner.setFlagValue("ak-role", "coder");
    session.extensionRunner.setFlagValue("ak-coder-phase", "apply");
    session.extensionRunner.setFlagValue("ak-coder-task", taskPath);
    await session.bindExtensions({ mode: "print" });
    assert.ok(
      session.agent.state.tools.some((tool) => tool.name === CODER_OUTPUT_TOOL_NAME),
    );
    assert.ok(
      session.agent.state.tools.some((tool) => tool.name === "write"),
      "Coder keeps construction tools",
    );

    let coderContext: Context | undefined;
    const output = {
      status: "completed",
      report:
        "TDD red/green evidence; same-pattern, introduced-regression, and behavior-fact checks complete.",
    };
    faux.setResponses([
      (context) => {
        coderContext = context;
        return fauxAssistantMessage(
          fauxToolCall(CODER_OUTPUT_TOOL_NAME, output, { id: "coder-completed" }),
          { stopReason: "toolUse" },
        );
      },
    ]);
    await session.prompt("/skill:tdd");

    const seenContext = coderContext as Context | undefined;
    assert.ok(seenContext);
    assert.ok(seenContext.systemPrompt?.includes(`<coder_soul>\n${coderSoul}\n</coder_soul>`));
    assert.ok(seenContext.systemPrompt?.includes(`<coder_task>\n${task}\n</coder_task>`));
    assert.equal(seenContext.systemPrompt?.includes("coder_quality_skill"), false);
    const userMessage = seenContext.messages.find((message) => message.role === "user");
    assert.ok(userMessage?.role === "user");
    const userText =
      typeof userMessage.content === "string"
        ? userMessage.content
        : userMessage.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    assert.equal(
      (userText.match(/<skill name="tdd"/g) ?? []).length,
      1,
      "Pi emits one native Skill block for the pre-prefixed command",
    );
    assert.deepEqual(parseSkillBlock(userText), {
      name: "tdd",
      location: tddSkillPath,
      content: `References are relative to ${dirname(tddSkillPath)}.\n\n${stripFrontmatter(tddSkillRaw).trim()}`,
      userMessage: undefined,
    });
    const accepted = sessionManager.getEntries().find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === "coder-completed",
    );
    assert.ok(accepted?.type === "message" && accepted.message.role === "toolResult");
    assert.equal(accepted.message.isError, false);
    assert.deepEqual(accepted.message.details, output);
  } finally {
    session.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("packaged fixer enforces singleton output without inheriting Judge tool narrowing", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[]; pi?: { extensions?: string[] } };
  const agentDir = await mkdtemp(resolve(tmpdir(), "ak-fixer-integration-"));
  const packetPath = resolve(agentDir, "fix-packet.md");
  await writeFile(packetPath, "# Approved repair\n\nApply it.");
  const faux = fauxProvider({
    api: "ak-fixer-offline",
    provider: "ak-fixer-offline",
    tokenSize: { min: 1000, max: 1000 },
  });
  const activeModel = faux.getModel();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: resolve(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Fixer integration auth",
        async resolve() {
          return { auth: { apiKey: "offline" } };
        },
      },
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: packageRoot,
    agentDir,
    additionalExtensionPaths: [packageEntrypoint(manifest)],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "FIXER INTEGRATION BASE PROMPT",
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(packageRoot);
  const { session } = await createAgentSession({
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
    customTools: [siblingTool],
    thinkingLevel: "off",
  });

  try {
    session.extensionRunner.setFlagValue("ak-role", "fixer");
    session.extensionRunner.setFlagValue("ak-fixer-phase", "apply");
    session.extensionRunner.setFlagValue("ak-fix-packet", packetPath);
    await session.bindExtensions({ mode: "print" });
    const activeNames = session.agent.state.tools.map((tool) => tool.name);
    for (const name of [
      "read",
      "bash",
      "edit",
      "write",
      "integration_sibling",
      FIXER_OUTPUT_TOOL_NAME,
    ]) {
      assert.ok(activeNames.includes(name), `${name} remains active for Fixer`);
    }

    const output = { status: "completed", report: "Repaired and verified." };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, { id: "mixed-fixer" }),
          fauxToolCall("integration_sibling", {}, { id: "mixed-sibling" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("singleton rejection observed"),
    ]);
    await session.prompt("Reject a mixed final batch.");
    const mixed = sessionManager.getEntries().find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === "mixed-fixer",
    );
    assert.ok(mixed?.type === "message" && mixed.message.role === "toolResult");
    assert.equal(mixed.message.isError, true);
    assert.match(textOf(mixed.message), /sole final tool call/);

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, { id: "sole-fixer" }),
        { stopReason: "toolUse" },
      ),
    ]);
    await session.prompt("Accept a sole Fixer output.");
    const accepted = sessionManager.getEntries().find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolCallId === "sole-fixer",
    );
    assert.ok(accepted?.type === "message" && accepted.message.role === "toolResult");
    assert.equal(accepted.message.isError, false);
    assert.deepEqual(accepted.message.details, output);
  } finally {
    session.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});
