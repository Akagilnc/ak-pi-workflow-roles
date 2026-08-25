/**
 * #319 Batch 2 (M2): Reviewer-unique deep chain only
 * (public ak-role Reviewer → auditor → Judge).
 * All-role cold smoke lives in public-cli-cold-matrix.test.ts.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { REVIEWER_CANDIDATE_ENTRY_TYPE } from "../../src/dossier-resolution.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  REVIEWER_AMENDMENT_TRACE_A,
  REVIEWER_AMENDMENT_TRACE_B,
} from "../fixtures/reviewer-two-axis-provider.ts";
import { withColdInstalledPackage, withHermeticHome, packageRoot } from "../helpers/pi-test-harness.ts";
import { runPiSubprocess } from "../helpers/pi-test-harness.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function seedReviewerFixture(fixture: string): Promise<void> {
  await git(fixture, "init");
  await git(fixture, "config", "user.email", "consumer@example.com");
  await git(fixture, "config", "user.name", "Consumer");
  await writeFile(resolve(fixture, ".gitignore"), "node_modules\n.pi-agent*\n");
  await writeFile(resolve(fixture, "consumer.txt"), "base\n");
  await git(fixture, "add", ".gitignore", "consumer.txt");
  await git(fixture, "commit", "-m", "base");
  await git(fixture, "branch", "review-base");
}

test("installed npm tarball runs public ak-role Reviewer→auditor→Judge chain", async () => {
  process.env.CI = "true";
  await withHermeticHome({ prefix: "ak-reviewer-package-" }, async ({ home }) => {
    await withColdInstalledPackage(home, async ({ fixture, pack, installedRoot }) => {
      assert.ok(pack.files.some((file) => file.path === "dist/public-cli/main.js"));
      assert.ok(pack.files.some((file) => file.path === "src/reviewer-dispatch.ts"));
      assert.ok(pack.files.some((file) => file.path === "resources/methods/code-review/SKILL.md"));
      assert.equal(pack.files.some((file) => file.path === "src/reviewer-admission.ts"), false);

      await seedReviewerFixture(fixture);
      // Honest two-axis smoke: local durable Spec path matched by feature branch token.
      await git(fixture, "checkout", "-b", "feature-login");
      await mkdir(resolve(fixture, "docs"), { recursive: true });
      await writeFile(resolve(fixture, "docs/feature-login.md"), "# Feature login\nMust authenticate users.\n");
      await writeFile(resolve(fixture, "consumer.txt"), "reviewed\n");
      await git(fixture, "add", "consumer.txt", "docs/feature-login.md");
      await git(fixture, "commit", "-m", "reviewed change with local spec material");

      const nestedCwd = resolve(fixture, "nested", "invocation");
      await mkdir(nestedCwd, { recursive: true });
      const agentDir = resolve(fixture, ".pi-agent");
      await mkdir(agentDir, { recursive: true });
      const providerPath = resolve(packageRoot, "test/fixtures/reviewer-two-axis-provider.ts");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const discoveredRefs = ["docs/feature-login.md"];
      // #443: capture parent systemPrompt at the real packaged Reviewer output call.
      const promptCapturePath = resolve(home, "reviewer-system-prompt.txt");
      const reviewerSoul = [
        await readFile(resolve(installedRoot, "CLAUDE.md"), "utf8"),
        await readFile(resolve(installedRoot, "souls/reviewer.md"), "utf8"),
      ].join("\n\n").trim();

      // #236 no-caller-instruction path: fixed base alone launches real two-axis when
      // unique discovery finds durable local Spec material (not bare commit #N).
      const reviewer = await runAkRole(
        [
          "reviewer",
          "--model",
          "ak-reviewer-two-axis/faux-1",
          "--thinking",
          "off",
          "--project",
          fixture,
          "--base",
          "review-base",
        ],
        {
          packageRoot: installedRoot,
          home,
          agentDir,
          cwd: nestedCwd,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-public-reviewer-001",
          reviewerExtraPiArgs: ["-e", providerPath],
          reviewerTimeoutMs: 120_000,
          io: {
            stdout: (text) => {
              stdout.push(text);
            },
            stderr: (text) => {
              stderr.push(text);
            },
          },
          piRunner: async (args, options) => {
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_REVIEW_EXPECT_AUTHORITY_REFS_JSON: JSON.stringify(discoveredRefs),
                AK_REVIEW_CAPTURE_SYSTEM_PROMPT: promptCapturePath,
              },
              timeoutMs: options.timeoutMs ?? 120_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.localTimeout,
              args: [...args],
            };
          },
        },
      );

      assert.equal(reviewer.exitCode, 0, stderr.join("") || JSON.stringify(reviewer.terminal) || "public reviewer failed");
      const capturedPrompt = await readFile(promptCapturePath, "utf8");
      assert.ok(
        capturedPrompt.includes(`<reviewer_soul>\n${reviewerSoul}\n</reviewer_soul>`),
        "installed Reviewer provider prompt carries constitution + reviewer soul",
      );
      assert.ok(reviewer.terminal);
      assert.equal(reviewer.terminal?.roleOutcome.kind, "accepted", JSON.stringify(reviewer.terminal));
      if (reviewer.terminal?.roleOutcome.kind === "accepted") {
        assert.equal(reviewer.terminal.roleOutcome.role, "reviewer");
        assert.equal(reviewer.terminal.roleOutcome.status, "completed");
        const facts = reviewer.terminal.roleOutcome.decisiveFacts as {
          axes?: unknown;
          reportAxes?: unknown;
          amendmentAxes?: unknown;
          amendments?: unknown;
        };
        assert.deepEqual(facts.axes, ["standards", "spec"]);
        assert.deepEqual(facts.reportAxes, ["standards", "spec"]);
        // Decisive facts project typed amendment axis presence only — never amendment prose.
        assert.deepEqual(facts.amendmentAxes, ["standards"]);
        assert.equal("amendments" in facts, false);
      }

      const reportArtifact = reviewer.terminal?.artifacts.find((item) => item.kind === "report");
      assert.ok(reportArtifact, `reviewer must publish frozen report artifact: ${JSON.stringify(reviewer.terminal)}`);
      const published = JSON.parse(await readFile(reportArtifact!.path, "utf8")) as {
        outcome?: { decisiveFacts?: { amendmentAxes?: unknown; amendments?: unknown } };
        receipt?: {
          acceptedBatch?: { legs?: Array<{ axis: string }> };
          reports?: { standards?: { text?: string }; spec?: { text?: string } };
          amendments?: { standards?: string; spec?: string };
          aggregate?: unknown;
          report?: unknown;
        };
        acceptedBatch?: { legs?: Array<{ axis: string }> };
        reports?: { standards?: { text?: string }; spec?: { text?: string } };
        amendments?: { standards?: string; spec?: string };
      };
      const frozenReviewerReceipt = published.receipt ?? published;
      assert.ok(
        frozenReviewerReceipt.acceptedBatch?.legs,
        `missing acceptedBatch in ${JSON.stringify(published).slice(0, 500)}`,
      );
      assert.deepEqual(
        frozenReviewerReceipt.acceptedBatch!.legs!.map((leg) => leg.axis),
        ["standards", "spec"],
      );
      assert.equal(
        (frozenReviewerReceipt as { specDisposition?: string }).specDisposition,
        "launched",
      );
      assert.equal(frozenReviewerReceipt.reports?.standards?.text, "Standards finding count: 0.");
      assert.equal(
        frozenReviewerReceipt.reports?.spec?.text,
        "Spec: fixed target satisfies the stated behavior.",
      );
      // Final receipt/artifact keep only amendment B after real auditor revise + resubmit.
      assert.deepEqual(frozenReviewerReceipt.amendments, REVIEWER_AMENDMENT_TRACE_B);
      assert.equal("aggregate" in frozenReviewerReceipt, false);
      assert.equal("report" in frozenReviewerReceipt, false);
      assert.deepEqual(published.outcome?.decisiveFacts?.amendmentAxes, ["standards"]);
      assert.equal("amendments" in (published.outcome?.decisiveFacts ?? {}), false);

      // Session custom entries: real output A then B candidates; child reports shared by identity, not re-prosed.
      const evidenceArtifact = reviewer.terminal?.artifacts.find((item) => item.kind === "evidence");
      assert.ok(evidenceArtifact, `reviewer must publish evidence artifact: ${JSON.stringify(reviewer.terminal)}`);
      const evidence = JSON.parse(await readFile(evidenceArtifact!.path, "utf8")) as {
        sessionFile?: string;
        sessionDirectory?: string;
      };
      assert.equal(typeof evidence.sessionFile, "string");
      const sessionRows = (await readFile(evidence.sessionFile!, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as {
          type?: string;
          customType?: string;
          data?: {
            version?: number;
            candidate?: {
              amendments?: { standards?: string; spec?: string };
              reports?: { standards?: { text?: string }; spec?: { text?: string } };
              aggregate?: unknown;
              report?: unknown;
            };
          };
          message?: {
            role?: string;
            toolName?: string;
            isError?: boolean;
            details?: { amendments?: { standards?: string } };
          };
        });
      const candidates = sessionRows.filter(
        (row) => row.type === "custom" && row.customType === REVIEWER_CANDIDATE_ENTRY_TYPE,
      );
      assert.equal(candidates.length, 2, `expected A then B candidates: ${JSON.stringify(candidates).slice(0, 500)}`);
      const candidateA = candidates[0]!.data?.candidate;
      const candidateB = candidates[1]!.data?.candidate;
      assert.deepEqual(candidateA?.amendments, REVIEWER_AMENDMENT_TRACE_A);
      assert.deepEqual(candidateB?.amendments, REVIEWER_AMENDMENT_TRACE_B);
      // Non-text rewrite contract: A/B candidates share the same reports object as the final receipt.
      assert.deepEqual(candidateA?.reports, frozenReviewerReceipt.reports);
      assert.deepEqual(candidateB?.reports, frozenReviewerReceipt.reports);
      for (const candidate of [candidateA, candidateB]) {
        assert.equal("aggregate" in (candidate ?? {}), false);
        assert.equal("report" in (candidate ?? {}), false);
      }
      const outputResults = sessionRows.filter(
        (row) =>
          row.type === "message" &&
          row.message?.role === "toolResult" &&
          row.message.toolName === "ak_reviewer_output",
      );
      assert.equal(outputResults.length, 2, "real output tool must run twice: A revise-bounce then B pass");
      assert.equal(outputResults[0]?.message?.isError, true);
      assert.equal(outputResults[1]?.message?.isError, false);
      assert.deepEqual(outputResults[1]?.message?.details?.amendments, REVIEWER_AMENDMENT_TRACE_B);

      // Caller-owned handoff: public Judge admits the frozen Reviewer receipt.
      const judgeProvider = resolve(packageRoot, "test/fixtures/audit-failure-provider.ts");
      const judgeStdout: string[] = [];
      const judgeStderr: string[] = [];
      const judge = await runAkRole(
        [
          "judge",
          "--model",
          "ak-audit-failure/faux-1",
          "--thinking",
          "off",
          "--project",
          fixture,
          `Adjudicate this exact auditor-accepted frozen Reviewer receipt:\n${JSON.stringify(frozenReviewerReceipt)}`,
        ],
        {
          packageRoot: installedRoot,
          home,
          agentDir,
          cwd: nestedCwd,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-public-judge-001",
          judgeExtraPiArgs: ["-e", judgeProvider],
          judgeTimeoutMs: 90_000,
          io: {
            stdout: (text) => {
              judgeStdout.push(text);
            },
            stderr: (text) => {
              judgeStderr.push(text);
            },
          },
          piRunner: async (args, options) => {
            const subprocess = await runPiSubprocess([...args], {
              cwd: options.cwd,
              env: {
                ...options.env,
                PI_OFFLINE: "1",
                AK_NAVIGATOR_DELIVERY_OUTCOME: "recommendation",
              },
              timeoutMs: options.timeoutMs ?? 90_000,
            });
            return {
              code: subprocess.code,
              stdout: subprocess.stdout,
              stderr: subprocess.stderr,
              timedOut: subprocess.localTimeout,
              args: [...args],
            };
          },
        },
      );
      assert.equal(judge.exitCode, 0, judgeStderr.join("") || "public judge failed");
      assert.ok(judge.terminal);
      assert.equal(judge.terminal?.roleOutcome.kind, "accepted");
    });
  });
});

// 尺②同根收拢（#420 类一）：原「public CLI Spec discovery tracer」三条冷装跑与
// 上方 test 1 同根——同一冷装链已断言 axes/reportAxes=[standards,spec]、冻结回执
// specDisposition="launched" 与报告 artifact。发现分类矩阵（refs-only / 本地发现 /
// confirmed-missing / authorityRefs 优先）由 test/unit/reviewer-dispatch.test.ts
// 在生产 dispatch 入口逐味承接；非空 authorityRefs 落 evidence artifact 由
// test/integration/public-cli-reviewer.test.ts 的 evidence 断言承接。
