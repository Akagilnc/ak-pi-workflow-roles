import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
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
import {
  loadRawPackageManifest,
  packageRoot,
  type RawPackageManifest,
  resolvePackageEntrypoint,
  runPiSubprocess,
  withHermeticHome,
  withInProcessPi,
  writeTestSkill,
} from "./helpers/pi-test-harness.ts";
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

function packageEntrypoint(manifest: RawPackageManifest): string {
  assert.ok(manifest.files?.includes("extensions"));
  assert.ok(manifest.files?.includes("souls"));
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/role-runtime.ts"]);
  return resolvePackageEntrypoint(manifest);
}

test("packaged CLI help exposes all five roles and Reviewer/Collector inputs", async () => {
  const manifest = await loadRawPackageManifest();
  const result = await runPiSubprocess(
    ["--no-extensions", "-e", packageEntrypoint(manifest), "--help"],
    { cwd: packageRoot },
  );
  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /--ak-role <value>\s+Activate a packaged workflow role: judge, fixer, coder, reviewer, or collector/,
  );
  assert.match(
    result.stdout,
    /--ak-review-task <value>\s+Opaque Markdown review task assigned to the reviewer role/,
  );
});

test("packaged CLI help exposes the complete fixer phase contract", async () => {
  const manifest = await loadRawPackageManifest();
  const result = await runPiSubprocess(
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
  assert.equal(result.code, 0);
  const extensionHelp = result.stdout.match(
    /Extension CLI Flags:\n([\s\S]*?)\n\nExamples:/,
  )?.[1];

  assert.equal(
    extensionHelp,
    [
      "  --ak-role <value>           Activate a packaged workflow role: judge, fixer, coder, reviewer, or collector",
      "  --ak-fix-packet <value>     Markdown repair packet assigned to the fixer role",
      "  --ak-fixer-phase <value>    Fixer phase: plan (inspect and propose a repair plan; no edits or commits) or apply (execute the approved plan, verify, and commit when repaired)",
      "  --ak-coder-task <value>     Markdown task assigned to the coder role",
      "  --ak-coder-phase <value>    Coder phase: plan (inspect and propose an implementation plan; no edits or commits) or apply (execute the approved plan and verify the first implementation)",
      "  --ak-review-task <value>    Opaque Markdown review task assigned to the reviewer role",
      "  --ak-collector-repo <value> GitHub owner/repo target for Collector (github.com only; conservative ASCII grammar). Collector forbids every Skill, including command-only Skills.",
      "  --ak-collector-pr <value>   Positive safe-integer pull request number for Collector. Supported profile: --no-skills, --no-extensions with only the explicit Collector package extension, no prompt templates/context files, one print/JSON prompt",
      "  --ak-collector-legs <value> Path to the Collector v1 leg manifest JSON file. Pi 0.82.1 late hostile sibling-extension Skill injection is unsupported and fail-closed when detected; drift prevention only, not a security boundary or provider-zero guarantee",
    ].join("\n") + "\n",
  );
});

test("packaged judge crosses Pi's loader, schema, persisted batch, auth-resolved audit, and termination boundaries offline", async () => {
  const manifest = await loadRawPackageManifest();
  const judgeSoul =
    (await readFile(resolve(packageRoot, "souls/judge.md"), "utf8")).trim();
  await withHermeticHome(
    { prefix: "ak-role-integration-" },
    async ({ agentDir }) => {
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
      await withInProcessPi({
        cwd: packageRoot,
        agentDir,
        faux,
        model: activeModel,
        provider: authResolvedProvider,
        modelsPath,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "INTEGRATION BASE PROMPT",
        mode: "print",
        flags: { "ak-role": "judge" },
        noTools: "builtin",
        customTools: [siblingTool],
      }, async ({ loader, session, sessionManager, extensions }) => {
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.equal(extensions.extensions.length, 1);
        assert.deepEqual(
          session.agent.state.tools.map((tool) => tool.name),
          ["read", "grep", "find", "ls", "bash", JUDGE_OUTPUT_TOOL_NAME],
          "Judge activation keeps exactly the registered evidence tools and output",
        );
        assert.equal(
          session.agent.state.tools.some((tool) =>
            ["write", "edit", "integration_sibling"].includes(tool.name)
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
        assert.match(
          textOf(schemaResult.message),
          /unexpected|additional propert/i,
        );
        assert.equal(
          faux.state.callCount,
          2,
          "schema rejection never invokes the audit model",
        );

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
        const auditContent = typeof auditInput.content === "string"
          ? [{ type: "text" as const, text: auditInput.content }]
          : auditInput.content;
        const auditText = auditContent
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.ok(
          auditText.includes(`<judge_soul>\n${judgeSoul}\n</judge_soul>`),
        );

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
        assert.deepEqual(acceptedResult.message.details, {
          judgeStatus: "converged",
        });
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
                  (part) =>
                    part.type === "toolCall" && part.id === "accepted-judge",
                ),
            ).length,
          1,
          "terminate ends the real Pi lifecycle without a follow-up provider turn",
        );
      });
    },
  );
});

test("packaged coder apply proves the immediately following canonical native tdd expansion", async () => {
  const manifest = await loadRawPackageManifest();
  const coderSoul =
    (await readFile(resolve(packageRoot, "souls/coder.md"), "utf8")).trim();
  await withHermeticHome(
    { prefix: "ak-coder-integration-" },
    async ({ home, agentDir }) => {
      const { path: tddSkillTargetPath, raw: tddSkillRaw } =
        await writeTestSkill(
          resolve(home, "owned-target"),
          "tdd",
        );
      const tddSkillPath = resolve(home, ".agents/skills/tdd/SKILL.md");
      await mkdir(dirname(tddSkillPath), { recursive: true });
      await symlink(tddSkillTargetPath, tddSkillPath);
      const taskPath = resolve(home, "approved-task.md");
      const task = "# Approved task\n\nImplement the first vertical slice.";
      await writeFile(taskPath, task);
      const faux = fauxProvider({
        api: "ak-coder-offline",
        provider: "ak-coder-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      await withInProcessPi({
        cwd: packageRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        additionalSkillPaths: [tddSkillPath],
        systemPrompt: "CODER INTEGRATION BASE PROMPT",
        mode: "print",
        flags: {
          "ak-role": "coder",
          "ak-coder-phase": "apply",
          "ak-coder-task": taskPath,
        },
        customTools: [siblingTool],
      }, async ({ session, sessionManager }) => {
        assert.ok(
          session.agent.state.tools.some((tool) =>
            tool.name === CODER_OUTPUT_TOOL_NAME
          ),
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
              fauxToolCall(CODER_OUTPUT_TOOL_NAME, output, {
                id: "coder-completed",
              }),
              { stopReason: "toolUse" },
            );
          },
        ]);
        await session.prompt("/skill:tdd");

        const seenContext = coderContext as Context | undefined;
        assert.ok(seenContext);
        assert.ok(
          seenContext.systemPrompt?.includes(
            `<coder_soul>\n${coderSoul}\n</coder_soul>`,
          ),
        );
        assert.ok(
          seenContext.systemPrompt?.includes(
            `<coder_task>\n${task}\n</coder_task>`,
          ),
        );
        assert.equal(
          seenContext.systemPrompt?.includes("coder_quality_skill"),
          false,
        );
        const userMessage = seenContext.messages.find((message) =>
          message.role === "user"
        );
        assert.ok(userMessage?.role === "user");
        const userText = typeof userMessage.content === "string"
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
          content: `References are relative to ${dirname(tddSkillPath)}.\n\n${
            stripFrontmatter(tddSkillRaw).trim()
          }`,
          userMessage: undefined,
        });
        const accepted = sessionManager.getEntries().find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolCallId === "coder-completed",
        );
        assert.ok(
          accepted?.type === "message" &&
            accepted.message.role === "toolResult",
        );
        assert.equal(accepted.message.isError, false);
        assert.deepEqual(accepted.message.details, output);
      });
    },
  );
});

test("packaged fixer enforces singleton output without inheriting Judge tool narrowing", async () => {
  const manifest = await loadRawPackageManifest();
  await withHermeticHome(
    { prefix: "ak-fixer-integration-" },
    async ({ home, agentDir }) => {
      const packetPath = resolve(home, "fix-packet.md");
      await writeFile(packetPath, "# Approved repair\n\nApply it.");
      const faux = fauxProvider({
        api: "ak-fixer-offline",
        provider: "ak-fixer-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      await withInProcessPi({
        cwd: packageRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "FIXER INTEGRATION BASE PROMPT",
        mode: "print",
        flags: {
          "ak-role": "fixer",
          "ak-fixer-phase": "apply",
          "ak-fix-packet": packetPath,
        },
        customTools: [siblingTool],
      }, async ({ session, sessionManager }) => {
        const activeNames = session.agent.state.tools.map((tool) => tool.name);
        for (
          const name of [
            "read",
            "bash",
            "edit",
            "write",
            "integration_sibling",
            FIXER_OUTPUT_TOOL_NAME,
          ]
        ) {
          assert.ok(
            activeNames.includes(name),
            `${name} remains active for Fixer`,
          );
        }

        const output = {
          status: "completed",
          report: "Repaired and verified.",
        };
        faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, {
                id: "mixed-fixer",
              }),
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
        assert.ok(
          mixed?.type === "message" && mixed.message.role === "toolResult",
        );
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
        assert.ok(
          accepted?.type === "message" &&
            accepted.message.role === "toolResult",
        );
        assert.equal(accepted.message.isError, false);
        assert.deepEqual(accepted.message.details, output);
      });
    },
  );
});
