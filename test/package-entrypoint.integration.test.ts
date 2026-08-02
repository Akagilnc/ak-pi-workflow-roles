import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
  FIXER_AUDIT_TOOL_NAME,
  FIXER_FLAG_DEFINITIONS,
  FIXER_OUTPUT_TOOL_NAME,
  FIXER_PHASES,
  fixerPrerequisitesSchema,
  parseFixerPrerequisites,
  validateFixerOutputForPacket,
  JUDGE_OUTPUT_TOOL_NAME,
  MERGER_INPUT_FLAG,
  MERGER_OUTPUT_TOOL_NAME,
  ROLE_FLAG,
  WORKFLOW_ROLES,
} from "../src/role-runtime.ts";
import { DOCTOR_CASE_FLAG } from "../src/doctor-role.ts";
import { SOUL_AUDIT_TOOL_NAME } from "../src/judge-auditor.ts";
import {
  loadRawPackageManifest,
  packIsolatedPackage,
  packageRoot,
  type RawPackageManifest,
  resolvePackageEntrypoint,
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

test("packed package includes Doctor role, evidence flag, and runtime dependencies", async () => {
  const manifest = await loadRawPackageManifest();
  packageEntrypoint(manifest);
  assert.equal(manifest.bin?.["ak-assisted-run"], "./bin/ak-assisted-run.js");
  assert.deepEqual(WORKFLOW_ROLES, ["judge", "fixer", "coder", "reviewer", "collector", "doctor", "navigator", "merger"]);
  assert.equal(ROLE_FLAG.name, "ak-role");
  assert.deepEqual(
    Object.values(FIXER_FLAG_DEFINITIONS).map(({ name, definition }) => ({
      name,
      type: definition.type,
    })),
    [
      { name: "ak-fix-packet", type: "string" },
      { name: "ak-fixer-prerequisites", type: "string" },
      { name: "ak-fixer-phase", type: "string" },
    ],
  );
  assert.deepEqual(FIXER_PHASES, ["plan", "apply"]);
  assert.equal(DOCTOR_CASE_FLAG.name, "ak-doctor-case");
  assert.equal(DOCTOR_CASE_FLAG.definition.type, "string");
  assert.equal(MERGER_INPUT_FLAG.name, "ak-merger-input");
  assert.equal(MERGER_OUTPUT_TOOL_NAME, "ak_merger_output");
  const packet = { instructions: "repair", prerequisites: parseFixerPrerequisites("[]") };
  assert.equal((fixerPrerequisitesSchema as any).type, "array");
  assert.deepEqual(validateFixerOutputForPacket({ status: "planned", report: "plan" }, "plan", packet), { status: "planned", report: "plan" });
  await withHermeticHome(
    { prefix: "ak-doctor-pack-" },
    async ({ home }) => {
      const packed = await packIsolatedPackage(home);
      const paths = new Set(packed.files.map((file) => file.path));
      for (const path of [
        "souls/doctor.md",
        "src/doctor-contracts.ts",
        "src/doctor-evidence.ts",
        "src/canonical-json.ts",
        "souls/navigator.md",
        "src/navigator-contracts.ts",
        "src/assisted-runner.ts",
        "schemas/assisted-call-v1.schema.json",
        "bin/ak-assisted-run.js",
        "souls/merger.md",
        "src/merger-contracts.ts",
        "src/merger-git-state.ts",
        "src/merger-role.ts",
        "src/package-contracts/fixer-packet.ts",
        "dist/package-contracts/fixer-packet.js",
        "packets/fixer-repair.md",
        "packets/fixer-prerequisites.json",
      ]) {
        assert.ok(paths.has(path), `${path} must be present in the npm tarball`);
      }
      assert.equal(paths.has("packets/fixer-repair.json"), false, "removed closed packet shell must not be packed");
    },
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
                { status: "pass", violations: [], conflicts: [], decisionGate: null },
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

test("packaged judge escalation terminates with one typed human decision and no follow-up turn", async () => {
  const manifest = await loadRawPackageManifest();
  await withHermeticHome(
    { prefix: "ak-judge-escalation-integration-" },
    async ({ agentDir }) => {
      const faux = fauxProvider({
        api: "ak-judge-escalation-offline",
        provider: "ak-judge-escalation-offline",
        tokenSize: { min: 1000, max: 1000 },
      });
      await withInProcessPi({
        cwd: packageRoot,
        agentDir,
        faux,
        additionalExtensionPaths: [packageEntrypoint(manifest)],
        systemPrompt: "JUDGE ESCALATION INTEGRATION PROMPT",
        mode: "print",
        flags: { "ak-role": "judge" },
        noTools: "builtin",
      }, async ({ session, sessionManager }) => {
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              JUDGE_OUTPUT_TOOL_NAME,
              { judgeStatus: "converged" },
              { id: "escalating-judge" },
            ),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage(
            fauxToolCall(
              SOUL_AUDIT_TOOL_NAME,
              {
                status: "escalate",
                violations: [],
                conflicts: ["Soul authority conflicts with controlling authority"],
                decisionGate: {
                  question: "Which authority governs this verdict?",
                  options: ["Soul", "Controlling authority"],
                },
              },
              { id: "audit-escalation" },
            ),
            { stopReason: "toolUse" },
          ),
        ]);
        await session.prompt("Exercise packaged audit escalation.");

        const result = sessionManager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === "escalating-judge",
          );
        assert.ok(
          result?.type === "message" && result.message.role === "toolResult",
        );
        assert.equal(result.message.isError, false);
        assert.deepEqual(result.message.details, {
          kind: "audit_escalation",
          conflicts: ["Soul authority conflicts with controlling authority"],
          decisionGate: {
            question: "Which authority governs this verdict?",
            options: ["Soul", "Controlling authority"],
          },
        });
        assert.match(textOf(result.message), /Human decision required/);
        assert.doesNotMatch(textOf(result.message), /Judge verdict accepted/i);
        assert.equal(faux.state.callCount, 2);
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
                    part.type === "toolCall" && part.id === "escalating-judge",
                ),
            ).length,
          1,
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

test("packaged coder apply transforms colliding /skill:tddfoo into canonical tdd expansion", async () => {
  const manifest = await loadRawPackageManifest();
  const coderSoul =
    (await readFile(resolve(packageRoot, "souls/coder.md"), "utf8")).trim();
  await withHermeticHome(
    { prefix: "ak-coder-collision-integration-" },
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
        const output = {
          status: "completed",
          report:
            "TDD red/green evidence; same-pattern, introduced-regression, and behavior-fact checks complete.",
        };
        let coderContext: Context | undefined;
        faux.setResponses([
          (context) => {
            coderContext = context;
            return fauxAssistantMessage(
              fauxToolCall(CODER_OUTPUT_TOOL_NAME, output, {
                id: "coder-collision-completed",
              }),
              { stopReason: "toolUse" },
            );
          },
        ]);
        await session.prompt("/skill:tddfoo");

        const seenContext = coderContext as Context | undefined;
        assert.ok(seenContext);
        assert.ok(
          seenContext.systemPrompt?.includes(
            `<coder_soul>\n${coderSoul}\n</coder_soul>`,
          ),
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
          "Pi emits one native Skill block after colliding prefix transform",
        );
        assert.deepEqual(parseSkillBlock(userText), {
          name: "tdd",
          location: tddSkillPath,
          content: `References are relative to ${dirname(tddSkillPath)}.\n\n${
            stripFrontmatter(tddSkillRaw).trim()
          }`,
          userMessage: "/skill:tddfoo",
        });
        const accepted = sessionManager.getEntries().find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolCallId === "coder-collision-completed",
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

test("packaged fixer applies its both-phase bash seatbelt, retains its tool surface, and enforces singleton output", async () => {
  const manifest = await loadRawPackageManifest();
  const forbiddenLiterals = [
    "rm -rf",
    "git reset --hard",
    "git clean",
    "git checkout --",
  ] as const;
  await withHermeticHome(
    { prefix: "ak-fixer-integration-" },
    async ({ home, agentDir }) => {
      const packetPath = resolve(home, "fix-packet.json");
      await writeFile(packetPath, JSON.stringify({ version: 1, instructions: "# Approved repair\n\nApply it.", prerequisites: [] }));
      for (const phase of ["plan", "apply"] as const) {
        const faux = fauxProvider({
          api: `ak-fixer-offline-${phase}`,
          provider: `ak-fixer-offline-${phase}`,
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
            "ak-fixer-phase": phase,
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
              `${name} remains active for Fixer ${phase}`,
            );
          }

          const markerDir = resolve(home, `fixer-markers-${phase}`);
          await mkdir(markerDir, { recursive: true });
          const controlMarker = resolve(markerDir, "control.txt");
          const forbiddenCalls = forbiddenLiterals.map((literal, index) => {
            const marker = resolve(markerDir, `blocked-${index}.txt`);
            return {
              literal,
              marker,
              id: `fixer-${phase}-blocked-${index}`,
              call: fauxToolCall(
                "bash",
                {
                  command:
                    `printf 'executed' > ${JSON.stringify(marker)} # ${literal}`,
                },
                { id: `fixer-${phase}-blocked-${index}` },
              ),
            };
          });
          faux.setResponses([
            fauxAssistantMessage(
              [
                ...forbiddenCalls.map((item) => item.call),
                fauxToolCall(
                  "bash",
                  {
                    command:
                      `printf 'control-ok' > ${JSON.stringify(controlMarker)}`,
                  },
                  { id: `fixer-${phase}-control` },
                ),
              ],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(`seatbelt matrix observed for ${phase}`),
          ]);
          await session.prompt(
            `Exercise Fixer bash seatbelt in ${phase} phase.`,
          );

          for (const item of forbiddenCalls) {
            const blocked = sessionManager.getEntries().find(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "toolResult" &&
                entry.message.toolCallId === item.id,
            );
            assert.ok(
              blocked?.type === "message" &&
                blocked.message.role === "toolResult",
              `${item.literal} must produce a tool result in ${phase}`,
            );
            assert.equal(
              blocked.message.isError,
              true,
              `${item.literal} must be an ordinary blocked/error result in ${phase}`,
            );
            assert.match(
              textOf(blocked.message),
              new RegExp(item.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
              `${item.literal} block reason must name the matched literal in ${phase}`,
            );
            await assert.rejects(
              () => access(item.marker),
              /ENOENT/,
              `${item.literal} must not execute bash in ${phase}`,
            );
          }

          const control = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `fixer-${phase}-control`,
          );
          assert.ok(
            control?.type === "message" && control.message.role === "toolResult",
          );
          assert.equal(
            control.message.isError,
            false,
            `harmless control bash must reach real packaged Pi bash in ${phase}`,
          );
          assert.equal(await readFile(controlMarker, "utf8"), "control-ok");

          const output = phase === "plan"
            ? { status: "planned", report: "Repair plan ready." }
            : { status: "completed", report: "Repaired and verified.", classResults: [{ name: "Contract", disposition: "completed", searchScope: "all", exceptions: [], commitSha: "a".repeat(40) }] };
          faux.setResponses([
            fauxAssistantMessage(
              [
                fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, {
                  id: `mixed-fixer-${phase}`,
                }),
                fauxToolCall("integration_sibling", {}, {
                  id: `mixed-sibling-${phase}`,
                }),
              ],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(`singleton rejection observed for ${phase}`),
          ]);
          await session.prompt(`Reject a mixed final batch in ${phase}.`);
          const mixed = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `mixed-fixer-${phase}`,
          );
          assert.ok(
            mixed?.type === "message" && mixed.message.role === "toolResult",
          );
          assert.equal(mixed.message.isError, true);
          assert.match(textOf(mixed.message), /sole final tool call/);

          faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall(FIXER_OUTPUT_TOOL_NAME, output, {
                id: `sole-fixer-${phase}`,
              }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(fauxToolCall(FIXER_AUDIT_TOOL_NAME, { status: "pass", violations: [], conflicts: [], decisionGate: null }), { stopReason: "toolUse" }),
          ]);
          await session.prompt(`Accept a sole Fixer output in ${phase}.`);
          const accepted = sessionManager.getEntries().find(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === `sole-fixer-${phase}`,
          );
          assert.ok(
            accepted?.type === "message" &&
              accepted.message.role === "toolResult",
          );
          assert.equal(accepted.message.isError, false);
          assert.deepEqual(accepted.message.details, output);
        });
      }
    },
  );
});
