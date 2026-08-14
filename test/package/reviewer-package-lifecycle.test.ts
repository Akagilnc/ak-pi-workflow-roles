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
import { runAkRole } from "../../src/public-cli/cli.ts";
import { withColdInstalledPackage, withHermeticHome, packageRoot } from "../helpers/pi-test-harness.ts";
import { runPiSubprocess } from "../helpers/pi-test-harness.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

test("installed npm tarball runs public ak-role Reviewer→auditor→Judge chain", async () => {
  process.env.CI = "true";
  await withHermeticHome({ prefix: "ak-reviewer-package-" }, async ({ home }) => {
    await withColdInstalledPackage(home, async ({ fixture, pack, installedRoot }) => {
      assert.ok(pack.files.some((file) => file.path === "dist/public-cli/main.js"));
      assert.ok(pack.files.some((file) => file.path === "src/reviewer-dispatch.ts"));
      assert.ok(pack.files.some((file) => file.path === "resources/methods/code-review/SKILL.md"));
      assert.equal(pack.files.some((file) => file.path === "src/reviewer-admission.ts"), false);

      await git(fixture, "init");
      await git(fixture, "config", "user.email", "consumer@example.com");
      await git(fixture, "config", "user.name", "Consumer");
      await writeFile(resolve(fixture, ".gitignore"), "node_modules\n.pi-agent*\n");
      await writeFile(resolve(fixture, "consumer.txt"), "base\n");
      await git(fixture, "add", ".gitignore", "consumer.txt");
      await git(fixture, "commit", "-m", "base");
      await git(fixture, "branch", "review-base");
      await writeFile(resolve(fixture, "consumer.txt"), "reviewed\n");
      // No public --authority-ref: independent discovery via commit issue ref must still launch Spec.
      await git(fixture, "commit", "-am", "reviewed change for #42");

      const nestedCwd = resolve(fixture, "nested", "invocation");
      await mkdir(nestedCwd, { recursive: true });
      const agentDir = resolve(fixture, ".pi-agent");
      await mkdir(agentDir, { recursive: true });
      const providerPath = resolve(packageRoot, "test/fixtures/reviewer-two-axis-provider.ts");
      const stdout: string[] = [];
      const stderr: string[] = [];

      // #236 no-caller-instruction path: fixed base alone must launch real two-axis dispatch
      // when independent discovery finds Spec materials (commit issue ref), without public refs.
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
      assert.ok(reviewer.terminal);
      assert.equal(reviewer.terminal?.roleOutcome.kind, "accepted", JSON.stringify(reviewer.terminal));
      if (reviewer.terminal?.roleOutcome.kind === "accepted") {
        assert.equal(reviewer.terminal.roleOutcome.role, "reviewer");
        assert.equal(reviewer.terminal.roleOutcome.status, "completed");
        const facts = reviewer.terminal.roleOutcome.decisiveFacts as {
          axes?: unknown;
          reportAxes?: unknown;
        };
        assert.deepEqual(facts.axes, ["standards", "spec"]);
        assert.deepEqual(facts.reportAxes, ["standards", "spec"]);
      }

      const reportArtifact = reviewer.terminal?.artifacts.find((item) => item.kind === "report");
      assert.ok(reportArtifact, `reviewer must publish frozen report artifact: ${JSON.stringify(reviewer.terminal)}`);
      const published = JSON.parse(await readFile(reportArtifact!.path, "utf8")) as {
        receipt?: {
          acceptedBatch?: { legs?: Array<{ axis: string }> };
          reports?: { standards?: { text?: string }; spec?: { text?: string } };
        };
        acceptedBatch?: { legs?: Array<{ axis: string }> };
        reports?: { standards?: { text?: string }; spec?: { text?: string } };
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

test("installed package transports exact authorityRefs into Spec child only", async () => {
  process.env.CI = "true";
  await withHermeticHome({ prefix: "ak-reviewer-authority-refs-" }, async ({ home }) => {
    await withColdInstalledPackage(home, async ({ fixture, installedRoot }) => {
      await git(fixture, "init");
      await git(fixture, "config", "user.email", "consumer@example.com");
      await git(fixture, "config", "user.name", "Consumer");
      await writeFile(resolve(fixture, ".gitignore"), "node_modules\n.pi-agent*\n");
      await writeFile(resolve(fixture, "consumer.txt"), "base\n");
      await git(fixture, "add", ".gitignore", "consumer.txt");
      await git(fixture, "commit", "-m", "base");
      await git(fixture, "branch", "review-base");
      await writeFile(resolve(fixture, "consumer.txt"), "reviewed\n");
      await git(fixture, "commit", "-am", "reviewed change");

      const nestedCwd = resolve(fixture, "nested", "invocation");
      await mkdir(nestedCwd, { recursive: true });
      const agentDir = resolve(fixture, ".pi-agent");
      await mkdir(agentDir, { recursive: true });
      const providerPath = resolve(packageRoot, "test/fixtures/reviewer-two-axis-provider.ts");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const authorityRefs = [
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
        "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
      ];

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
          "--authority-ref",
          authorityRefs[0]!,
          "--authority-ref",
          authorityRefs[1]!,
          "Scope and procedure only; do not promote this prose to Spec authority.",
        ],
        {
          packageRoot: installedRoot,
          home,
          agentDir,
          cwd: nestedCwd,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => "run-public-reviewer-authority-refs-001",
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
                // Real package lifecycle tracer: Spec child must receive exact refs; Standards must not.
                AK_REVIEW_EXPECT_AUTHORITY_REFS_JSON: JSON.stringify(authorityRefs),
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

      assert.equal(
        reviewer.exitCode,
        0,
        stderr.join("") || JSON.stringify(reviewer.terminal) || "authorityRefs package lifecycle failed",
      );
      assert.equal(reviewer.terminal?.roleOutcome.kind, "accepted");

      const evidenceArtifact = reviewer.terminal?.artifacts.find((item) => item.kind === "evidence");
      assert.ok(evidenceArtifact, "reviewer must publish evidence artifact");
      const evidence = JSON.parse(await readFile(evidenceArtifact!.path, "utf8")) as {
        authorityRefs?: unknown;
      };
      assert.deepEqual(evidence.authorityRefs, authorityRefs);
    });
  });
});

test("public CLI no-refs: independent discovery launches Spec; confirmed missing skips Spec",
  async () => {
    process.env.CI = "true";
    await withHermeticHome({ prefix: "ak-reviewer-missing-spec-" }, async ({ home }) => {
      await withColdInstalledPackage(home, async ({ fixture, installedRoot }) => {
        await git(fixture, "init");
        await git(fixture, "config", "user.email", "consumer@example.com");
        await git(fixture, "config", "user.name", "Consumer");
        await writeFile(resolve(fixture, ".gitignore"), "node_modules\n.pi-agent*\n");
        await writeFile(resolve(fixture, "consumer.txt"), "base\n");
        await git(fixture, "add", ".gitignore", "consumer.txt");
        await git(fixture, "commit", "-m", "base");
        await git(fixture, "branch", "review-base");

        const nestedCwd = resolve(fixture, "nested", "invocation");
        await mkdir(nestedCwd, { recursive: true });
        const agentDir = resolve(fixture, ".pi-agent");
        await mkdir(agentDir, { recursive: true });
        const providerPath = resolve(packageRoot, "test/fixtures/reviewer-two-axis-provider.ts");

        const runReviewer = async (options: {
          runId: string;
          commitMessage: string;
          expectAxes: "standards" | "standards,spec";
          expectDisposition: "launched" | "skipped-missing";
        }) => {
          await writeFile(resolve(fixture, "consumer.txt"), `${options.runId}\n`);
          await git(fixture, "add", "consumer.txt");
          await git(fixture, "commit", "-m", options.commitMessage);
          const stderr: string[] = [];
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
              createRunId: () => options.runId,
              reviewerExtraPiArgs: ["-e", providerPath],
              reviewerTimeoutMs: 120_000,
              io: {
                stdout: () => {},
                stderr: (text) => {
                  stderr.push(text);
                },
              },
              piRunner: async (args, runOptions) => {
                const subprocess = await runPiSubprocess([...args], {
                  cwd: runOptions.cwd,
                  env: {
                    ...runOptions.env,
                    PI_OFFLINE: "1",
                    AK_REVIEW_EXPECT_AXES: options.expectAxes,
                  },
                  timeoutMs: runOptions.timeoutMs ?? 120_000,
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
          assert.equal(
            reviewer.exitCode,
            0,
            stderr.join("") || JSON.stringify(reviewer.terminal) || `${options.runId} failed`,
          );
          assert.equal(reviewer.terminal?.roleOutcome.kind, "accepted");
          if (reviewer.terminal?.roleOutcome.kind !== "accepted") return;
          const facts = reviewer.terminal.roleOutcome.decisiveFacts as {
            axes?: unknown;
            reportAxes?: unknown;
            specDisposition?: unknown;
          };
          const expectedAxes =
            options.expectAxes === "standards" ? ["standards"] : ["standards", "spec"];
          assert.deepEqual(facts.axes, expectedAxes);
          assert.deepEqual(facts.reportAxes, expectedAxes);
          assert.equal(facts.specDisposition, options.expectDisposition);

          const reportArtifact = reviewer.terminal.artifacts.find((item) => item.kind === "report");
          assert.ok(reportArtifact, `${options.runId} must publish report artifact`);
          const published = JSON.parse(await readFile(reportArtifact!.path, "utf8")) as {
            receipt?: { specDisposition?: string; acceptedBatch?: { legs?: Array<{ axis: string }> } };
            specDisposition?: string;
            acceptedBatch?: { legs?: Array<{ axis: string }> };
          };
          const receipt = published.receipt ?? published;
          assert.equal(receipt.specDisposition, options.expectDisposition);
          assert.deepEqual(
            receipt.acceptedBatch?.legs?.map((leg) => leg.axis),
            expectedAxes,
          );
        };

        // Path A: no public refs; commit issue ref ⇒ independent discovery launches Spec.
        await runReviewer({
          runId: "run-public-reviewer-discovery-launch-001",
          commitMessage: "land feature for #77",
          expectAxes: "standards,spec",
          expectDisposition: "launched",
        });

        // Reset range base so the next commit is the sole reviewed change with no Spec materials.
        await git(fixture, "branch", "-f", "review-base", "HEAD");

        // Path B: no public refs; independent scan finds nothing ⇒ confirmed missing skips Spec.
        await runReviewer({
          runId: "run-public-reviewer-missing-spec-001",
          commitMessage: "chore: local polish without tracker or spec file",
          expectAxes: "standards",
          expectDisposition: "skipped-missing",
        });
      });
    });
  },
);
