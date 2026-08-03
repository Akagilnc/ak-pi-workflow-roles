import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

async function runHealthyNavigatorAuditFailureCli(mode: "print" | "json", siblingOrder: "failure-first" | "sibling-first") {
  return withHermeticHome(
    { prefix: `ak-audit-navigator-${siblingOrder}-` },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      const sessionDirectory = resolve(issueRoot, "runs/judge/session");
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(resolve(issueRoot, "authority.md"), "owner authority for Navigator drain\n", "utf8");
      await writeFile(resolve(agentDir, "navigator-model.json"), JSON.stringify({ model: "ak-audit-failure/faux-1" }), "utf8");
      const args = [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        "--session-dir", sessionDirectory,
        "-e", resolve(packageRoot, "extensions/role-runtime.ts"),
        "-e", resolve(packageRoot, "test/fixtures/audit-failure-provider.ts"),
        "--ak-role", "judge",
        "--provider", "ak-audit-failure", "--model", "faux-1",
        ...(mode === "print" ? ["-p", "Judge."] : ["--mode", "json", "Judge."]),
      ];
      return runPiSubprocess(args, {
        cwd: issueRoot,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          AK_HEALTHY_NAVIGATOR: "1",
          AK_NAVIGATOR_SIBLING_ORDER: siblingOrder,
          AK_NAVIGATOR_ROOT: issueRoot,
          PI_OFFLINE: "1",
        },
      });
    },
  );
}

async function runFixerAuditFailureCli(mode: "print" | "json") {
  return withHermeticHome({ prefix: "ak-fixer-audit-fatal-cli-" }, async ({ home, agentDir }) => {
    const packet = resolve(home, "packet.json");
    const runDirectory = resolve(packageRoot, `.ak/work/issues/44/runs/audit-failure-subprocess-${mode}`);
    const sessionDirectory = resolve(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(packet, JSON.stringify({ version: 1, instructions: "Settle Contract.", prerequisites: [] }));
    await writeFile(resolve(runDirectory, "invocation.json"), JSON.stringify({
      role: "fixer",
      phase: "apply",
      mode,
      provider: "ak-fixer-audit-failure",
      model: "faux-1",
    }, null, 2));
    const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--session-dir", sessionDirectory,
      "-e", resolve(packageRoot, "extensions/role-runtime.ts"), "-e", resolve(packageRoot, "test/fixtures/fixer-audit-failure-provider.ts"),
      "--ak-role", "fixer", "--ak-fixer-phase", "apply", "--ak-fix-packet", packet,
      "--provider", "ak-fixer-audit-failure", "--model", "faux-1",
      ...(mode === "print" ? ["-p", "Apply."] : ["--mode", "json", "Apply."])];
    const result = await runPiSubprocess(args, { cwd: packageRoot, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
    await writeFile(resolve(runDirectory, "stderr.log"), result.stderr);
    return result;
  });
}

type ReviewerFailureStage =
  | "preflight-git"
  | "preflight-skill"
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
      await writeFile(
        canonicalSkillPath,
        stage === "preflight-skill"
          ? "---\nname: code-review\ndescription: malformed\n---\n\n# Missing canonical sections\n"
          : await readFile(resolve(packageRoot, "test/fixtures/canonical-code-review-SKILL.md")),
      );
      const cwd = resolve(home, "review-target");
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", packageRoot, cwd]);
      const taskPath = resolve(cwd, "test/fixtures/reviewer-task.md");
      const taskBytes = await readFile(taskPath);
      const capabilityPath = resolve(home, "reviewer-capabilities.json");
      const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd, encoding: "utf8" }).trim();
      const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const diffCommand = `git diff ${base}...${target}`;
      await writeFile(capabilityPath, JSON.stringify({
        version: 1,
        taskSha256: createHash("sha256").update(taskBytes).digest("hex"),
        tools: ["read", "bash"],
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
    assert.equal(result.timedOut, false, `${mode} subprocess did not time out`);
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

test("fatal Judge audit failure drains one healthy packaged Navigator without advice in both sibling orders", async () => {
  for (const siblingOrder of ["failure-first", "sibling-first"] as const) {
    const result = await runHealthyNavigatorAuditFailureCli("json", siblingOrder);
    assert.equal(result.timedOut, false, `${siblingOrder} subprocess did not time out`);
    assert.equal(result.code, 1, `${siblingOrder} exits nonzero`);
    assert.match(result.stderr, /NAVIGATOR_CALLS=1/);
    assert.match(result.stderr, new RegExp(`NAVIGATOR_SIBLING_ORDER=${siblingOrder}`));
    const timestamp = (name: string) => {
      const value = result.stderr.match(new RegExp(`${name}=([^\\n]+)`))?.[1];
      assert.ok(value, `${siblingOrder} must emit ${name}`);
      const parsed = Date.parse(value);
      assert.ok(Number.isFinite(parsed), `${name} must be an ISO timestamp`);
      return parsed;
    };
    const startedAt = timestamp("NAVIGATOR_STARTED_AT");
    const completedAt = timestamp("NAVIGATOR_COMPLETED_AT");
    const preparedAt = timestamp("NAVIGATOR_PREPARED_AT");
    const settledAt = timestamp("NAVIGATOR_SETTLEMENT_AT");
    assert.ok(startedAt <= completedAt, `${siblingOrder} preparation start must precede completion`);
    assert.ok(completedAt <= preparedAt, `${siblingOrder} provider completion must precede typed preparation persistence`);
    assert.ok(preparedAt <= settledAt, `${siblingOrder} preparation must precede settlement`);
    assert.match(result.stderr, /NAVIGATOR_SETTLEMENT_KIND=role_infrastructure_failure/);
    assert.match(result.stderr, /NAVIGATOR_RELEASE_AFTER_DRAIN=true/);
    assert.doesNotMatch(result.stdout, /ak-navigator-attendance|导航不可用|路线：/);
    assert.doesNotMatch(result.stdout, /FORBIDDEN LATER SUCCESS PROSE/);
    assert.match(result.stdout, /"toolName":"ak_judge_output".*"isError":true/);
  }
});

test("fatal Fixer audit infrastructure failure aborts print and JSON without a receipt", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runFixerAuditFailureCli(mode);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, `${mode} subprocess did not time out`);
    assert.equal(result.code, 1, combined);
    assert.match(combined, /invalid fixer audit decision|Request was aborted/);
    assert.match(result.stderr, /FIXER_AUDIT_FAILURE_PROVIDER_CALLS=3/);
    assert.doesNotMatch(result.stdout, /Fixer report accepted|FORBIDDEN LATER SUCCESS PROSE/);
  }
});

test("unavailable canonical tdd is infrastructure failure in print and JSON", async () => {
  for (const fixture of ["missing", "unreadable", "empty"] as const) {
    for (const mode of ["print", "json"] as const) {
      const result = await runCoderSkillFailureCli(mode, fixture);
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.timedOut, false, `${fixture}/${mode} subprocess did not time out`);
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
      stage: "preflight-git",
      marker: /INJECTED_REVIEWER_GIT_IO_FAILURE|not a git repository/,
      calls: 1,
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
      assert.equal(result.timedOut, false, `${row.stage}/${mode} subprocess did not time out`);
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
