import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

import {
  packageRoot,
  packIsolatedPackage,
  withHermeticHome,
  withInProcessPi,
  writeTestSkill,
} from "./helpers/pi-test-harness.ts";

const AGENT_TOOL_NAME = "Agent";
const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
const REVIEWER_AUDIT_TOOL_NAME = "ak_reviewer_audit_decision";
const exec = promisify(execFile);

function textOfUser(context: Context): string {
  const message = context.messages.find((candidate) =>
    candidate.role === "user"
  );
  if (message?.role !== "user") return "";
  return typeof message.content === "string" ? message.content : message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

function structuredRecord(context: Context): any {
  const match = textOfUser(context).match(
    /<structured_execution_record>([\s\S]*?)<\/structured_execution_record>/,
  );
  assert.ok(match, "auditor request contains a structured execution record");
  return JSON.parse(match[1]!);
}

test("installed npm tarball runs native Reviewer expansion in an independent consumer repository", async () => {
  await withHermeticHome(
    { prefix: "ak-reviewer-package-" },
    async ({ home: temp }) => {
      const fixture = resolve(temp, "fixture");
      const agentDir = resolve(fixture, ".pi-agent");
      const { path: canonicalSkillPath, raw: canonicalRaw } =
        await writeTestSkill(
          temp,
          "code-review",
        );
      await mkdir(fixture, { recursive: true });
      const consumerRoot = await realpath(fixture);
      await git(fixture, "init");
      await git(fixture, "config", "user.email", "consumer@example.com");
      await git(fixture, "config", "user.name", "Consumer");
      await writeFile(resolve(fixture, "consumer.txt"), "base\n");
      await git(fixture, "add", "consumer.txt");
      await git(fixture, "commit", "-m", "consumer base");
      const base = await git(fixture, "rev-parse", "HEAD");
      await git(fixture, "branch", "review-base", base);
      await git(fixture, "tag", "review-base", base);
      await writeFile(resolve(fixture, "consumer.txt"), "reviewed\n");
      await git(fixture, "commit", "-am", "consumer reviewed change");
      const reviewedHead = await git(fixture, "rev-parse", "HEAD");

      const pack = await packIsolatedPackage(temp);
      const tarball = pack.tarball;
      const paths = pack.files.map((file) => file.path);
      assert.deepEqual(paths, [
        "README.md",
        "bin/ak-docket-record.js",
        "dist/package-contracts/collector-output.js",
        "dist/package-contracts/judge-output.js",
        "dist/package-contracts/reviewer-output.js",
        "dist/package-contracts/terminating-tools.js",
        "dist/package-contracts/worker-output.js",
        "dist/recorder/admit.js",
        "dist/recorder/cli.js",
        "dist/recorder/config.js",
        "dist/recorder/errors.js",
        "dist/recorder/extract.js",
        "dist/recorder/manifest.js",
        "dist/recorder/paths.js",
        "dist/recorder/rename_no_replace.node",
        "dist/recorder/rename-no-replace.js",
        "dist/recorder/run.js",
        "dist/recorder/scanner.js",
        "dist/recorder/spawn.js",
        "extensions/role-runtime.ts",
        "package.json",
        "schemas/collector-legs-v1.schema.json",
        "schemas/recorder-failure-v1.schema.json",
        "schemas/recorder-manifest-v1.schema.json",
        "scripts/build-rename-no-replace.mjs",
        "scripts/rename_no_replace.c",
        "souls/coder.md",
        "souls/collector.md",
        "souls/fixer.md",
        "souls/judge.md",
        "souls/reviewer.md",
        "src/canonical-skill-binding.ts",
        "src/collector-config.ts",
        "src/collector-evidence.ts",
        "src/collector-github.ts",
        "src/collector-ledger.ts",
        "src/collector-receipt.ts",
        "src/collector-role.ts",
        "src/collector-tool-schemas.ts",
        "src/compliance-transport.ts",
        "src/judge-role.ts",
        "src/package-contracts/collector-output.ts",
        "src/package-contracts/judge-output.ts",
        "src/package-contracts/reviewer-output.ts",
        "src/package-contracts/terminating-tools.ts",
        "src/package-contracts/worker-output.ts",
        "src/recorder/admit.ts",
        "src/recorder/cli.ts",
        "src/recorder/config.ts",
        "src/recorder/errors.ts",
        "src/recorder/extract.ts",
        "src/recorder/manifest.ts",
        "src/recorder/paths.ts",
        "src/recorder/rename-no-replace.ts",
        "src/recorder/run.ts",
        "src/recorder/scanner.ts",
        "src/recorder/spawn.ts",
        "src/reviewer-agent.ts",
        "src/reviewer-auditor.ts",
        "src/reviewer-execution-ledger.ts",
        "src/reviewer-role.ts",
        "src/reviewer-scope-prompt.ts",
        "src/reviewer-verification-policy.ts",
        "src/role-runtime.ts",
        "src/soul-auditor.ts",
        "src/worker-role.ts",
      ]);
      assert.equal(paths.includes("src/reviewer-skill.ts"), false);
      assert.equal(paths.some((path) => /(^|\/)SKILL\.md$/.test(path)), false);
      const archiveText = (await exec("tar", ["-xOf", tarball], {
        maxBuffer: 5 * 1024 * 1024,
      })).stdout;
      assert.doesNotMatch(
        archiveText,
        /Mysterious Name|Under 400 words|Feature Envy/,
      );

      await writeFile(
        resolve(fixture, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            "@ak/pi-workflow-roles": `file:${tarball}`,
            "@earendil-works/pi-ai": `file:${
              resolve(packageRoot, "node_modules/@earendil-works/pi-ai")
            }`,
            "@earendil-works/pi-coding-agent": `file:${
              resolve(
                packageRoot,
                "node_modules/@earendil-works/pi-coding-agent",
              )
            }`,
            typebox: `file:${resolve(packageRoot, "node_modules/typebox")}`,
          },
        }),
      );
      await exec("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ], {
        cwd: fixture,
        maxBuffer: 5 * 1024 * 1024,
      });
      const installedRoot = resolve(
        fixture,
        "node_modules/@ak/pi-workflow-roles",
      );
      const installedEntrypoint = resolve(
        installedRoot,
        "extensions/role-runtime.ts",
      );
      await writeFile(
        resolve(fixture, "review-task.md"),
        [
          "# Fixed review task",
          "",
          "Review the consumer repository's current HEAD against HEAD~1.",
          "There is no separate spec.",
        ].join("\n"),
      );

      const faux = fauxProvider({
        api: "ak-reviewer-package",
        provider: "ak-reviewer-package",
        tokenSize: { min: 1000, max: 1000 },
      });
      let parentContext: Context | undefined;
      const childContexts: Context[] = [];
      const auditContexts: Context[] = [];
      let activeChildren = 0;
      let peakChildren = 0;
      let axisStarts = 0;
      let releaseAxes!: () => void;
      const axisBarrier = new Promise<void>((resolveBarrier) => {
        releaseAxes = resolveBarrier;
      });
      const axisResponse = (report: string) => async (context: Context) => {
        childContexts.push(context);
        activeChildren += 1;
        peakChildren = Math.max(peakChildren, activeChildren);
        axisStarts += 1;
        if (axisStarts === 2) releaseAxes();
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            axisBarrier,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                releaseAxes();
                reject(
                  new Error(
                    "REVIEWER_PARALLELISM_TIMEOUT: sibling Agent did not overlap",
                  ),
                );
              }, 2_000);
            }),
          ]);
          return fauxAssistantMessage(report);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          activeChildren -= 1;
        }
      };
      const candidate = {
        status: "completed" as const,
        report: "## Standards\nAxis report.\n\n## Spec\nNo spec available.",
      };
      const corrected = {
        status: "completed" as const,
        report:
          "## Standards\nStandards child report preserved.\n\n## Spec\nNo spec available.\n\nStandards: 0; Spec: skipped.",
      };
      let auditCalls = 0;
      let sessionManager: SessionManager;
      const assertBatchEvidence = (context: Context) => {
        const record = structuredRecord(context);
        const entries = sessionManager.getEntries();
        const assistantEntryFor = (toolCallId: string) =>
          entries.find((entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.content.some((part) =>
              part.type === "toolCall" && part.id === toolCallId
            )
          );
        const axisEntry = assistantEntryFor("standards-leg");
        const specEntry = assistantEntryFor("spec-leg");
        const laterEntry = assistantEntryFor("followup-leg");
        assert.ok(axisEntry && specEntry && laterEntry);
        assert.equal(axisEntry.id, specEntry.id);
        assert.notEqual(axisEntry.id, laterEntry.id);
        assert.deepEqual(record.agentInvocationBatches, [
          {
            assistantSessionEntryId: axisEntry.id,
            executionMode: "parallel",
            agentToolCallIds: ["standards-leg", "spec-leg"],
          },
          {
            assistantSessionEntryId: laterEntry.id,
            executionMode: "parallel",
            agentToolCallIds: ["followup-leg"],
          },
        ]);
        assert.deepEqual(
          record.agentInvocationBatches.map((batch: any) =>
            batch.assistantSessionEntryId
          ),
          [axisEntry.id, laterEntry.id],
        );
        for (const attempt of record.agentAttempts) {
          assert.equal(attempt.targetSnapshot.repositoryRoot, consumerRoot);
          assert.equal(attempt.targetSnapshot.targetHead, reviewedHead);
          assert.notEqual(attempt.targetSnapshot.repositoryRoot, packageRoot);
        }
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
        axisResponse("Standards child report."),
        axisResponse("No spec available."),
        fauxAssistantMessage(
          fauxToolCall(AGENT_TOOL_NAME, {
            subagent_type: "general-purpose",
            description: "Traceability follow-up",
            prompt: "Confirm the pinned consumer HEAD.",
          }, { id: "followup-leg" }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          childContexts.push(context);
          return fauxAssistantMessage("Pinned consumer HEAD confirmed.");
        },
        fauxAssistantMessage(
          fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, candidate, {
            id: "candidate",
          }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          auditContexts.push(context);
          assertBatchEvidence(context);
          auditCalls += 1;
          return fauxAssistantMessage(
            fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, {
              status: "revise",
              violations: ["Add the required per-axis summary"],
            }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage(
          fauxToolCall(REVIEWER_OUTPUT_TOOL_NAME, corrected, {
            id: "corrected",
          }),
          { stopReason: "toolUse" },
        ),
        (context) => {
          auditContexts.push(context);
          assertBatchEvidence(context);
          auditCalls += 1;
          return fauxAssistantMessage(
            fauxToolCall(REVIEWER_AUDIT_TOOL_NAME, {
              status: "pass",
              violations: [],
            }),
            { stopReason: "toolUse" },
          );
        },
      ]);
      await withInProcessPi({
        cwd: fixture,
        agentDir,
        faux,
        modelsPath: null,
        additionalExtensionPaths: [installedEntrypoint],
        additionalSkillPaths: [canonicalSkillPath],
        noExtensions: true,
        systemPrompt: "PACKAGED REVIEWER BASE",
        mode: "print",
        flags: {
          "ak-role": "reviewer",
          "ak-review-task": resolve(fixture, "review-task.md"),
        },
        reviewerShutdown: true,
      }, async ({ loader, session, sessionManager: activeSessionManager }) => {
        assert.deepEqual(loader.getExtensions().errors, []);
        sessionManager = activeSessionManager;
        assert.deepEqual(
          session.agent.state.tools.map((tool) => tool.name),
          [
            "read",
            "grep",
            "find",
            "ls",
            "bash",
            AGENT_TOOL_NAME,
            REVIEWER_OUTPUT_TOOL_NAME,
          ],
        );
        const before = {
          bytes: await readFile(resolve(fixture, "consumer.txt"), "utf8"),
          head: await git(fixture, "rev-parse", "HEAD"),
          refs: await git(fixture, "show-ref"),
        };

        await session.prompt("Review this fixed point.");

        assert.ok(parentContext);
        const expanded = textOfUser(parentContext);
        assert.ok(
          expanded.includes(
            `<skill name="code-review" location="${canonicalSkillPath}">`,
          ),
        );
        assert.ok(expanded.includes(stripFrontmatter(canonicalRaw).trim()));
        assert.equal(childContexts.length, 3);
        assert.equal(peakChildren, 2);
        assert.equal(axisStarts, 2);
        assert.equal(activeChildren, 0);
        for (const child of childContexts) {
          assert.deepEqual(child.tools?.map((tool) => tool.name), [
            "read",
            "grep",
            "find",
            "ls",
            "bash",
            "write",
            "edit",
          ]);
        }
        const agentResults = sessionManager.getEntries().filter((entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === AGENT_TOOL_NAME
        );
        assert.equal(agentResults.length, 3);
        for (const entry of agentResults) {
          assert.ok(
            entry.type === "message" && entry.message.role === "toolResult",
          );
          assert.ok((entry.message.usage?.totalTokens ?? 0) > 0);
          assert.equal(
            (entry.message.details as any).targetSnapshot.repositoryRoot,
            consumerRoot,
          );
          assert.equal(
            (entry.message.details as any).targetSnapshot.targetHead,
            reviewedHead,
          );
        }
        assert.equal(auditCalls, 2);
        assert.equal(auditContexts.length, 2);
        assert.deepEqual(auditContexts[0]?.tools?.map((tool) => tool.name), [
          REVIEWER_AUDIT_TOOL_NAME,
        ]);
        assert.match(
          textOfUser(auditContexts[0]!),
          /canonical_code_review_skill/,
        );
        const first = sessionManager.getEntries().find((entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "candidate"
        );
        assert.ok(
          first?.type === "message" && first.message.role === "toolResult",
        );
        assert.equal(first.message.isError, true);
        const accepted = sessionManager.getEntries().find((entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "corrected"
        );
        assert.ok(
          accepted?.type === "message" &&
            accepted.message.role === "toolResult",
        );
        assert.equal(accepted.message.isError, false);
        assert.deepEqual(accepted.message.details, corrected);
        assert.deepEqual({
          bytes: await readFile(resolve(fixture, "consumer.txt"), "utf8"),
          head: await git(fixture, "rev-parse", "HEAD"),
          refs: await git(fixture, "show-ref"),
        }, before);
        assert.equal(reviewedHead, await git(fixture, "rev-parse", "HEAD"));
        assert.equal(faux.getPendingResponseCount(), 0);
      });
    },
  );
});
