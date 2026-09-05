import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
/**
 * #319 Batch 2 (M2): Reviewer-unique deep chain only
 * (public ak-role Reviewer → Judge; #495 S6 dropped reviewer-side auditor).
 * #685: all-role cold smoke + update live in public-cli-cold-matrix (heavy).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { REVIEWER_AMENDMENT_TRACE } from "../fixtures/reviewer-two-axis-provider.ts";
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

test("installed npm tarball runs public ak-role Reviewer→Judge chain", async () => {
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
      // #470 御批四 + #495 S2: reviewer main session carries audit-law + quality-law.
      const reviewerSoul = [
        await readFile(resolve(installedRoot, "CLAUDE.md"), "utf8"),
        await readFile(resolve(installedRoot, "souls/reviewer.md"), "utf8"),
        await readFile(resolve(installedRoot, "souls/audit-law.md"), "utf8"),
        await readFile(resolve(installedRoot, "souls/quality-law.md"), "utf8"),
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
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: installedRoot,
            principalAuthority: piDurablePrincipalAuthority,
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
            extraPiArgs: ["-e", providerPath],
          }),
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
      // #495 S6: single accept — no auditor revise/resubmit loop.
      assert.deepEqual(frozenReviewerReceipt.amendments, REVIEWER_AMENDMENT_TRACE);
      assert.equal("aggregate" in frozenReviewerReceipt, false);
      assert.equal("report" in frozenReviewerReceipt, false);
      assert.deepEqual(published.outcome?.decisiveFacts?.amendmentAxes, ["standards"]);
      assert.equal("amendments" in (published.outcome?.decisiveFacts ?? {}), false);

      // Session: one accepted output; no first-record candidate custom entries after gate retirement.
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
          message?: {
            role?: string;
            toolName?: string;
            isError?: boolean;
            details?: { amendments?: { standards?: string } };
          };
        });
      const candidates = sessionRows.filter(
        (row) => row.type === "custom" && row.customType === "ak_reviewer_audit_candidate",
      );
      assert.equal(candidates.length, 0, "reviewer-side audit candidate custom entries must not be written");
      const outputResults = sessionRows.filter(
        (row) =>
          row.type === "message" &&
          row.message?.role === "toolResult" &&
          row.message.toolName === "ak_reviewer_output",
      );
      assert.equal(outputResults.length, 1, "single typed accept after legs");
      assert.equal(outputResults[0]?.message?.isError, false);
      const closureResults = sessionRows.filter(
        (row) => row.type === "custom" && row.customType === "ak-role-submission-closure",
      );
      assert.equal(closureResults.length, 1, "single typed closure after legs");
      assert.deepEqual(((closureResults[0] as any)?.data?.details ?? (closureResults[0] as any)?.details)?.amendments, REVIEWER_AMENDMENT_TRACE);

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
          `Adjudicate this exact frozen Reviewer receipt:\n${JSON.stringify(frozenReviewerReceipt)}`,
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
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: installedRoot,
            principalAuthority: piDurablePrincipalAuthority,
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
            extraPiArgs: ["-e", judgeProvider],
          }),
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
