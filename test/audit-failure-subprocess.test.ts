import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  packageRoot,
  runPiSubprocess,
  withHermeticHome,
  writeTestSkill,
} from "./helpers/pi-test-harness.ts";

async function runCli(mode: "print" | "json") {
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-session",
    "-e",
    resolve(packageRoot, "extensions/role-runtime.ts"),
    "-e",
    resolve(packageRoot, "test/fixtures/audit-failure-provider.ts"),
    "--ak-role",
    "judge",
    "--provider",
    "ak-audit-failure",
    "--model",
    "faux-1",
    ...(mode === "print" ? ["-p", "Judge."] : ["--mode", "json", "Judge."]),
  ];

  return withHermeticHome(
    { prefix: "ak-audit-cli-" },
    async ({ agentDir }) =>
      runPiSubprocess(args, {
        cwd: packageRoot,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
      }),
  );
}

type ReviewerFailureStage =
  | "child-provider"
  | "child-session"
  | "child-malformed-output"
  | "audit-auth"
  | "audit-provider"
  | "audit-malformed-decision";

async function runReviewerCli(
  mode: "print" | "json",
  stage: ReviewerFailureStage,
) {
  return withHermeticHome(
    { prefix: "ak-reviewer-fatal-cli-" },
    async ({ home, agentDir }) => {
      const { path: canonicalSkillPath } = await writeTestSkill(
        home,
        "code-review",
      );
      await writeFile(canonicalSkillPath, [
        "---", "name: code-review", "description: fatal-stage fixture", "---", "",
        "# Code review", "## Standards baseline", "Check correctness.",
        "## Standards review burden", "Apply the baseline.",
        "## Spec review burden", "Check each established requirement.", "",
      ].join("\n"));
      const cwd = packageRoot;
      const taskPath = resolve(packageRoot, "test/fixtures/reviewer-task.md");
      const taskBytes = await readFile(taskPath);
      const capabilityPath = resolve(home, "reviewer-capabilities.json");
      await writeFile(capabilityPath, JSON.stringify({
        version: 1,
        taskSha256: createHash("sha256").update(taskBytes).digest("hex"),
        tools: ["read"],
        bashCommands: [],
        prerequisiteOperations: [
          "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
          "preflight.git.list-ordered-commits", "preflight.git.read-material", "runner.git.materialize-mirror",
          "runner.git.materialize-workspace", "runner.git.verify-snapshot",
        ],
      }));
      const args = [
        "--no-extensions",
        "--no-skills",
        "--skill",
        canonicalSkillPath,
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "-e",
        resolve(packageRoot, "extensions/role-runtime.ts"),
        "-e",
        resolve(packageRoot, "test/fixtures/reviewer-failure-provider.ts"),
        "--ak-role",
        "reviewer",
        "--ak-review-task",
        taskPath,
        "--ak-review-capabilities",
        capabilityPath,
        "--provider",
        "ak-reviewer-failure",
        "--model",
        "faux-1",
        ...(mode === "print"
          ? ["-p", "Review."]
          : ["--mode", "json", "Review."]),
      ];
      return runPiSubprocess(args, {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          AK_REVIEWER_FAILURE_STAGE: stage,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
      });
    },
  );
}

async function runCoderSkillFailureCli(
  mode: "print" | "json",
  fixture: "missing" | "unreadable" | "empty",
) {
  return withHermeticHome(
    { prefix: "ak-coder-skill-fatal-cli-" },
    async ({ home, agentDir }) => {
      const skillPath = resolve(home, ".agents/skills/tdd/SKILL.md");
      const taskPath = resolve(home, "coder-task.md");
      await writeFile(
        taskPath,
        "# Approved task\n\nApply the approved slice.\n",
      );
      if (fixture === "unreadable") {
        await mkdir(skillPath, { recursive: true });
      } else if (fixture === "empty") {
        await mkdir(dirname(skillPath), { recursive: true });
        await writeFile(
          skillPath,
          "---\nname: tdd\ndescription: empty fixture\n---\n\n",
        );
      }
      const args = [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "-e",
        resolve(packageRoot, "extensions/role-runtime.ts"),
        "-e",
        resolve(packageRoot, "test/fixtures/coder-skill-failure-provider.ts"),
        "--ak-role",
        "coder",
        "--ak-coder-phase",
        "apply",
        "--ak-coder-task",
        taskPath,
        "--provider",
        "ak-coder-skill-failure",
        "--model",
        "faux-1",
        ...(mode === "print" ? ["-p", "Apply."] : ["--mode", "json", "Apply."]),
      ];
      return runPiSubprocess(args, {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
      });
    },
  );
}

test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runCli(mode);
    assert.equal(result.code, 1, `${mode} exits nonzero`);
    assert.match(
      result.stderr,
      /Request was aborted|AUDIT_FAILURE_PROVIDER_CALLS/,
    );
    assert.doesNotMatch(result.stdout, /Judge verdict accepted/);
    assert.doesNotMatch(result.stdout, /FORBIDDEN LATER SUCCESS PROSE/);
    if (mode === "json") {
      assert.match(
        result.stdout,
        /"toolName":"ak_judge_output".*"isError":true/,
      );
      assert.match(result.stdout, /"stopReason":"aborted"/);
    }
  }
});

test("unavailable canonical tdd is infrastructure failure in print and JSON", async () => {
  for (const fixture of ["missing", "unreadable", "empty"] as const) {
    for (const mode of ["print", "json"] as const) {
      const result = await runCoderSkillFailureCli(mode, fixture);
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 1, `${fixture}/${mode} exits nonzero`);
      assert.match(
        combined,
        /Canonical tdd Skill|Coder canonical tdd Skill binding was not initialized/,
      );
      assert.doesNotMatch(combined, /Coder report accepted/);
      if (mode === "json") {
        const events = result.stdout
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => JSON.parse(line));
        const outputResults = events.filter((event) =>
          event.type === "message_end" &&
          event.message?.role === "toolResult" &&
          event.message.toolName === "ak_coder_output"
        );
        assert.equal(
          outputResults.some((event) => event.message.isError === false),
          false,
          `${fixture}/${mode} has no accepted Coder output`,
        );
        assert.equal(
          outputResults.some((event) =>
            event.message.details?.status !== undefined
          ),
          false,
          `${fixture}/${mode} does not encode infrastructure as a receipt status`,
        );
      }
    }
  }
});

test("installed Reviewer fatal stages abort without a receipt", async () => {
  const rows: Array<{
    stage: ReviewerFailureStage;
    marker: RegExp;
    calls: number;
    tool: "Agent" | "ak_reviewer_output";
  }> = [
    {
      stage: "child-provider",
      marker: /Reviewer Agent provider not found/,
      calls: 1,
      tool: "Agent",
    },
    {
      stage: "child-session",
      marker: /INJECTED_REVIEWER_CHILD_SESSION_FAILURE/,
      calls: 2,
      tool: "Agent",
    },
    {
      stage: "child-malformed-output",
      marker: /Reviewer Agent returned a blank child report/,
      calls: 2,
      tool: "Agent",
    },
    {
      stage: "audit-auth",
      marker: /INJECTED_REVIEWER_AUDIT_AUTH_FAILURE/,
      calls: 1,
      tool: "ak_reviewer_output",
    },
    {
      stage: "audit-provider",
      marker: /Reviewer compliance audit provider not found/,
      calls: 1,
      tool: "ak_reviewer_output",
    },
    {
      stage: "audit-malformed-decision",
      marker: /invalid reviewer audit decision/,
      calls: 2,
      tool: "ak_reviewer_output",
    },
  ];
  for (const row of rows) {
    for (const mode of ["json", "print"] as const) {
      const result = await runReviewerCli(mode, row.stage);
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 1, `${row.stage}/${mode} exits nonzero\n${combined}`);
      assert.match(
        combined,
        row.marker,
        `${row.stage}/${mode} reached its stage`,
      );
      assert.match(combined, /Request was aborted|"stopReason":"aborted"/);
      assert.match(
        result.stderr,
        new RegExp(`REVIEWER_FAILURE_PROVIDER_CALLS=${row.calls}(?:\\D|$)`),
        `${row.stage}/${mode} made exactly ${row.calls} provider calls`,
      );
      assert.doesNotMatch(result.stdout, /Reviewer report accepted/);
      assert.doesNotMatch(combined, /FORBIDDEN INFRASTRUCTURE REFUSAL/);
      assert.doesNotMatch(combined, /FORBIDDEN LATER SUCCESS PROSE/);
      if (mode === "json") {
        const events = result.stdout
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .map((line) => JSON.parse(line));
        const erroredTool = events.find((event) =>
          event.type === "message_end" &&
          event.message?.role === "toolResult" &&
          event.message.toolName === row.tool &&
          event.message.isError === true
        );
        assert.ok(erroredTool, `${row.stage} marks ${row.tool} isError:true`);
        assert.ok(events.some((event) =>
          event.type === "message_end" &&
          event.message?.role === "assistant" &&
          event.message.stopReason === "aborted"
        ));
      }
    }
  }
});
