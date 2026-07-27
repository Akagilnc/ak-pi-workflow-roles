import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const piCli = resolve(packageRoot, "node_modules/.bin/pi");

async function runCli(mode: "print" | "json") {
  const agentDir = await mkdtemp(resolve(tmpdir(), "ak-audit-cli-"));
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

  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(piCli, args, {
          cwd: packageRoot,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolveResult({ code, stdout, stderr }));
      },
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

type ReviewerFailureStage =
  | "child-preparation"
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
  const agentDir = await mkdtemp(resolve(tmpdir(), "ak-reviewer-fatal-cli-"));
  const cwd = stage === "child-preparation" ? agentDir : packageRoot;
  const args = [
    "--no-extensions",
    "--no-skills",
    "--skill",
    resolve(homedir(), ".agents/skills/code-review/SKILL.md"),
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
    resolve(packageRoot, "test/fixtures/reviewer-task.md"),
    "--provider",
    "ak-reviewer-failure",
    "--model",
    "faux-1",
    ...(mode === "print" ? ["-p", "Review."] : ["--mode", "json", "Review."]),
  ];
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(piCli, args, {
          cwd,
          env: {
            ...process.env,
            AK_REVIEWER_FAILURE_STAGE: stage,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolveResult({ code, stdout, stderr }));
      },
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runCli(mode);
    assert.equal(result.code, 1, `${mode} exits nonzero`);
    assert.match(result.stderr, /Request was aborted|AUDIT_FAILURE_PROVIDER_CALLS/);
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

test("every mandated Reviewer fatal stage aborts print and JSON at its intended seam", async () => {
  const rows: Array<{
    stage: ReviewerFailureStage;
    marker: RegExp;
    calls: number;
    tool: "Agent" | "ak_reviewer_output";
  }> = [
    {
      stage: "child-preparation",
      marker: /not a git repository/i,
      calls: 1,
      tool: "Agent",
    },
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
    for (const mode of ["print", "json"] as const) {
      const result = await runReviewerCli(mode, row.stage);
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 1, `${row.stage}/${mode} exits nonzero`);
      assert.match(combined, row.marker, `${row.stage}/${mode} reached its stage`);
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
