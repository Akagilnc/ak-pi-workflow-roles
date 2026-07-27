import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

import {
  AGENT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
} from "../src/role-runtime.ts";
import { REVIEWER_AUDIT_TOOL_NAME } from "../src/reviewer-auditor.ts";

const exec = promisify(execFile);
const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function textOfUser(context: Context): string {
  const message = context.messages.find((candidate) => candidate.role === "user");
  if (message?.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

test("installed npm tarball runs native Reviewer expansion through parallel Agents and audit correction", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "ak-reviewer-package-"));
  const fixture = resolve(temp, "fixture");
  const agentDir = resolve(temp, "agent");
  const canonicalSkillPath = await realpath(
    resolve(homedir(), ".agents/skills/code-review/SKILL.md"),
  );
  const canonicalRaw = await readFile(canonicalSkillPath, "utf8");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const pack = JSON.parse((await exec(
      "npm",
      ["pack", "--json", "--pack-destination", temp],
      { cwd: packageRoot },
    )).stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const tarball = resolve(temp, pack[0]!.filename);
    const paths = pack[0]!.files.map((file) => file.path);
    assert.ok(paths.includes("souls/reviewer.md"));
    assert.ok(paths.includes("src/reviewer-agent.ts"));
    assert.equal(paths.some((path) => /(^|\/)SKILL\.md$/.test(path)), false);
    const archiveText = (await exec("tar", ["-xOf", tarball], {
      maxBuffer: 5 * 1024 * 1024,
    })).stdout;
    assert.doesNotMatch(archiveText, /Mysterious Name|Under 400 words|Feature Envy/);

    await writeFile(resolve(temp, "package.json"), JSON.stringify({
      private: true,
      dependencies: {
        "@ak/pi-workflow-roles": `file:${tarball}`,
        "@earendil-works/pi-ai": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-ai")}`,
        "@earendil-works/pi-coding-agent": `file:${resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent")}`,
        typebox: `file:${resolve(packageRoot, "node_modules/typebox")}`,
      },
    }));
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: temp,
      maxBuffer: 5 * 1024 * 1024,
    });
    const installedRoot = resolve(temp, "node_modules/@ak/pi-workflow-roles");
    const installedEntrypoint = resolve(installedRoot, "extensions/role-runtime.ts");
    await writeFile(resolve(temp, "review-task.md"), [
      "# Fixed review task",
      "",
      "Review the current HEAD against HEAD~1.",
      "There is no separate spec.",
    ].join("\n"));

    const faux = fauxProvider({
      api: "ak-reviewer-package",
      provider: "ak-reviewer-package",
      tokenSize: { min: 1000, max: 1000 },
    });
    let parentContext: Context | undefined;
    const childContexts: Context[] = [];
    const auditContexts: Context[] = [];
    let childStarts = 0;
    let releaseChildren!: () => void;
    const childBarrier = new Promise<void>((resolveBarrier) => {
      releaseChildren = resolveBarrier;
    });
    const candidate = {
      status: "completed" as const,
      report: "## Standards\nAxis report.\n\n## Spec\nNo spec available.",
    };
    const corrected = {
      status: "completed" as const,
      report: "## Standards\nStandards child report preserved.\n\n## Spec\nNo spec available.\n\nStandards: 0; Spec: skipped.",
    };
    faux.setResponses([
      (context) => {
        parentContext = context;
        return fauxAssistantMessage([
          fauxToolCall(AGENT_TOOL_NAME, {
            subagent_type: "general-purpose",
            description: "Standards axis",
            prompt: "Review Standards for git diff HEAD~1...HEAD.",
          }, { id: "standards-leg" }),
          fauxToolCall(AGENT_TOOL_NAME, {
            subagent_type: "general-purpose",
            description: "Spec axis",
            prompt: "Report no spec available for git diff HEAD~1...HEAD.",
          }, { id: "spec-leg" }),
        ], { stopReason: "toolUse" });
      },
      ...["Standards child report.", "No spec available."].map((report) =>
        async (context: Context) => {
          childContexts.push(context);
          childStarts += 1;
          if (childStarts === 2) releaseChildren();
          await childBarrier;
          return fauxAssistantMessage(report);
        }),
      fauxAssistantMessage(
        fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, candidate, { id: "candidate" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        auditContexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, {
            status: "revise",
            violations: ["Add the required per-axis summary"],
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage(
        fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, corrected, { id: "corrected" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        auditContexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, {
            status: "pass",
            violations: [],
          }),
          { stopReason: "toolUse" },
        );
      },
    ]);
    const model = faux.getModel();
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    runtime.registerNativeProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Package lifecycle auth",
          async resolve() { return { auth: { apiKey: "offline" } }; },
        },
      },
      getModels() { return [model]; },
    });
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: packageRoot,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [installedEntrypoint],
      additionalSkillPaths: [canonicalSkillPath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "PACKAGED REVIEWER BASE",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const sessionManager = SessionManager.inMemory(packageRoot);
    ({ session } = await createAgentSession({
      cwd: packageRoot,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager,
      settingsManager: settings,
    }));
    session.extensionRunner.setFlagValue("ak-role", "reviewer");
    session.extensionRunner.setFlagValue(
      "ak-review-task",
      resolve(temp, "review-task.md"),
    );
    await session.bindExtensions({ mode: "print" });
    assert.deepEqual(
      session.agent.state.tools.map((tool) => tool.name),
      ["read", "grep", "find", "ls", "bash", AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME],
    );

    await session.prompt("Review this fixed point.");

    assert.ok(parentContext);
    const expanded = textOfUser(parentContext);
    assert.ok(expanded.includes(`<skill name="code-review" location="${canonicalSkillPath}">`));
    assert.ok(expanded.includes(stripFrontmatter(canonicalRaw).trim()));
    assert.equal(childContexts.length, 2);
    assert.notEqual(childContexts[0], childContexts[1]);
    for (const child of childContexts) {
      assert.deepEqual(child.tools?.map((tool) => tool.name), [
        "read", "grep", "find", "ls", "bash", "write", "edit",
      ]);
    }
    const agentResults = sessionManager.getEntries().filter((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === AGENT_TOOL_NAME
    );
    assert.equal(agentResults.length, 2);
    for (const entry of agentResults) {
      assert.ok(entry.type === "message" && entry.message.role === "toolResult");
      assert.ok((entry.message.usage?.totalTokens ?? 0) > 0);
    }
    assert.equal(auditContexts.length, 2);
    assert.deepEqual(auditContexts[0]?.tools?.map((tool) => tool.name), [
      REVIEWER_AUDIT_TOOL_NAME,
    ]);
    const auditRecord = textOfUser(auditContexts[0]!);
    assert.match(auditRecord, /canonical_code_review_skill/);
    assert.match(auditRecord, /standards-leg/);
    assert.match(auditRecord, /spec-leg/);
    assert.match(auditRecord, /candidate_receipt/);
    const first = sessionManager.getEntries().find((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === "candidate"
    );
    assert.ok(first?.type === "message" && first.message.role === "toolResult");
    assert.equal(first.message.isError, true);
    const accepted = sessionManager.getEntries().find((entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === "corrected"
    );
    assert.ok(accepted?.type === "message" && accepted.message.role === "toolResult");
    assert.equal(accepted.message.isError, false);
    assert.deepEqual(accepted.message.details, corrected);
    assert.equal(faux.getPendingResponseCount(), 0);
  } finally {
    if (session !== undefined) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await rm(temp, { recursive: true, force: true });
  }
});
