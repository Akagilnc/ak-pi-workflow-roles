import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { runFixerAuditFailureCli } from "../helpers/fixer-audit-cli.ts";
import {
  packageRoot,
  runPiSubprocess,
  withHermeticHome,
  withInProcessPi,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

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

async function runHealthyNavigatorAuditFailureCli(mode: "print" | "json") {
  return withHermeticHome(
    { prefix: "ak-audit-navigator-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      const sessionDirectory = resolve(issueRoot, "runs/judge/session");
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        resolve(issueRoot, "authority.md"),
        "owner authority for Navigator drain\n",
        "utf8",
      );
      await writeFile(
        resolve(agentDir, "navigator-model.json"),
        JSON.stringify({ model: "ak-audit-failure/faux-1" }),
        "utf8",
      );
      const args = [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--session-dir",
        sessionDirectory,
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
      return runPiSubprocess(args, {
        cwd: issueRoot,
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          AK_HEALTHY_NAVIGATOR: "1",
          AK_NAVIGATOR_ROOT: issueRoot,
          PI_OFFLINE: "1",
        },
      });
    },
  );
}

type ReviewerFailureStage =
  | "preflight-git"
  | "audit-auth"
  | "audit-provider"
  | "audit-malformed-decision";

/** One shared review-target clone for the whole file — rows cp -R it. */
let reviewerTargetTemplateMemo: Promise<string> | undefined;
async function reviewerTargetTemplate(): Promise<string> {
  reviewerTargetTemplateMemo ??= (async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ak-reviewer-fatal-template-"));
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", packageRoot, root], {
      stdio: "ignore",
    });
    return root;
  })();
  return reviewerTargetTemplateMemo;
}

async function materializeReviewerTarget(dest: string): Promise<void> {
  const template = await reviewerTargetTemplate();
  await rm(dest, { recursive: true, force: true });
  await cp(template, dest, { recursive: true });
}

async function runReviewerCli(mode: "print" | "json", stage: ReviewerFailureStage) {
  return withHermeticHome(
    { prefix: "ak-reviewer-fatal-cli-" },
    async ({ home, agentDir }) => {
      const { path: canonicalSkillPath } = await writeTestSkill(home, "code-review");
      await writeFile(
        canonicalSkillPath,
        await readFile(resolve(packageRoot, "test/fixtures/canonical-code-review-SKILL.md")),
      );
      const cwd = resolve(home, "review-target");
      await materializeReviewerTarget(cwd);
      const taskPath = resolve(cwd, "test/fixtures/reviewer-task.md");
      const taskBytes = await readFile(taskPath);
      const capabilityPath = resolve(home, "reviewer-capabilities.json");
      const base = execFileSync("git", ["rev-parse", "HEAD~1"], {
        cwd,
        encoding: "utf8",
      }).trim();
      const target = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim();
      void base;
      void target;
      await writeFile(
        capabilityPath,
        JSON.stringify({
          version: 1,
          taskSha256: createHash("sha256").update(taskBytes).digest("hex"),
          tools: ["read", "bash"],
          prerequisiteOperations: [
            "preflight.git.pin-target",
            "preflight.git.resolve-base",
            "preflight.git.derive-range",
            "preflight.git.list-ordered-commits",
            "preflight.git.read-material",
            "runner.git.materialize-mirror",
            "runner.git.materialize-workspace",
            "runner.git.verify-snapshot",
          ],
        }),
      );
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
        ...(mode === "print" ? ["-p", "Review."] : ["--mode", "json", "Review."]),
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
      await writeFile(taskPath, "# Approved task\n\nApply the approved slice.\n");
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

function assertAuditAbortWithoutReceipt(
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
  label: string,
) {
  assert.equal(result.timedOut, false, `${label} subprocess did not time out`);
  assert.equal(result.code, 1, `${label} exits nonzero`);
  assert.doesNotMatch(
    result.stdout,
    /Judge verdict accepted|Fixer report accepted|Reviewer report accepted|Coder report accepted/,
  );
  assert.doesNotMatch(result.stdout, /FORBIDDEN LATER SUCCESS PROSE/);
}

test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runCli(mode);
    assertAuditAbortWithoutReceipt(result, mode);
    assert.match(
      result.stderr,
      /Request was aborted|AUDIT_FAILURE_PROVIDER_CALLS/,
    );
    if (mode === "json") {
      assert.match(
        result.stdout,
        /"toolName":"ak_judge_output".*"isError":true/,
      );
      assert.match(result.stdout, /"stopReason":"aborted"/);
    }
  }
});

test("fatal Judge audit failure drains one healthy packaged Navigator without advice", async () => {
  // Process boundary required: process-release evidence is emitted on process exit.
  const result = await runHealthyNavigatorAuditFailureCli("json");
  assert.equal(result.timedOut, false, "subprocess did not time out");
  assert.equal(result.code, 1, "subprocess exits nonzero");
  const evidenceLine = result.stderr
    .split("\n")
    .find((line) => line.startsWith("AUDIT_FAILURE_EVIDENCE="));
  assert.ok(evidenceLine, `must emit typed evidence: ${result.stderr}`);
  const evidence = JSON.parse(
    evidenceLine.slice("AUDIT_FAILURE_EVIDENCE=".length),
  ) as {
    providerCalls: number;
    navigatorCalls: number;
    navigator: {
      startedAt: string;
      completedAt: string;
      preparedAt: string;
      settledAt: string;
      settlementKind: string;
      inputReleasedAt: string;
      releaseAfterDrain: boolean;
    };
    role: {
      failedOutput: {
        toolCallId: string;
        toolName: string;
        isError: boolean;
        details: Record<string, unknown>;
      };
      failedOutputAt: string;
      failedOutputCorrelation: boolean;
    };
  };
  assert.equal(evidence.navigatorCalls, 1);
  assert.equal(evidence.navigator.settlementKind, "role_infrastructure_failure");
  const timestamp = (value: string, label: string) => {
    const parsed = Date.parse(value);
    assert.ok(Number.isFinite(parsed), `${label} must be an ISO timestamp`);
    return parsed;
  };
  const startedAt = timestamp(evidence.navigator.startedAt, "preparation start");
  const completedAt = timestamp(evidence.navigator.completedAt, "preparation completion");
  const preparedAt = timestamp(evidence.navigator.preparedAt, "typed preparation persistence");
  const settledAt = timestamp(evidence.navigator.settledAt, "typed settlement");
  const inputReleasedAt = timestamp(evidence.navigator.inputReleasedAt, "input release");
  const processReleaseLine = result.stderr
    .split("\n")
    .find((line) => line.startsWith("AUDIT_FAILURE_PROCESS_RELEASE="));
  assert.ok(processReleaseLine, "must emit process release evidence");
  const processReleasedAt = timestamp(
    (JSON.parse(processReleaseLine.slice("AUDIT_FAILURE_PROCESS_RELEASE=".length)) as {
      at: string;
    }).at,
    "process release",
  );
  timestamp(evidence.role.failedOutputAt, "failed output result");
  assert.ok(
    startedAt <= completedAt && completedAt <= preparedAt && preparedAt <= settledAt,
    "Navigator preparation must drain before settlement",
  );
  assert.ok(
    settledAt <= inputReleasedAt && inputReleasedAt <= processReleasedAt,
    "input and process release must follow the drained Navigator settlement",
  );
  assert.deepEqual(evidence.role.failedOutput, {
    toolCallId: "fatal-judge",
    toolName: "ak_judge_output",
    isError: true,
    details: {},
  });
  assert.equal(
    evidence.role.failedOutputCorrelation,
    true,
    "failure must correlate the exact Judge output call",
  );
  assert.equal(evidence.navigator.releaseAfterDrain, true);
  const events = result.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as any);
  const failedOutputs = events.filter(
    (event) =>
      event.type === "message_end" &&
      event.message?.role === "toolResult" &&
      event.message.toolName === "ak_judge_output" &&
      event.message.toolCallId === "fatal-judge",
  );
  assert.equal(failedOutputs.length, 1, "must report exactly the failed Judge output call");
  assert.equal(failedOutputs[0].message.isError, true);
  assert.equal(
    events.some(
      (event) =>
        event.type === "message_end" &&
        event.message?.role === "assistant" &&
        event.message.stopReason === "aborted",
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "custom_message" && event.customType === "ak-navigator-attendance",
    ),
    false,
    "infrastructure failure must remain typed silence",
  );
  assert.doesNotMatch(result.stdout, /FORBIDDEN LATER SUCCESS PROSE/);
});

test("fatal Fixer audit infrastructure failure aborts print and JSON without a receipt", async () => {
  // Distinct Fixer marker (FIXER_AUDIT_FAILURE_PROVIDER_CALLS) is the absorbed clause
  // that the Judge survivor does not cover — keep Fixer-specific process proof.
  for (const mode of ["print", "json"] as const) {
    const result = await runFixerAuditFailureCli({ mode });
    const combined = `${result.stdout}\n${result.stderr}`;
    assertAuditAbortWithoutReceipt(result, `fixer/${mode}`);
    assert.match(combined, /invalid fixer audit decision|Request was aborted/);
    assert.match(result.stderr, /FIXER_AUDIT_FAILURE_PROVIDER_CALLS=3/);
    assert.doesNotMatch(result.stdout, /Fixer report accepted|FORBIDDEN LATER SUCCESS PROSE/);
  }
});

test("unavailable canonical tdd is infrastructure failure in print and JSON", async () => {
  // Unavailability matrix (missing/unreadable/empty) is owned by
  // canonical-skill-binding.test.ts. Keep ONE fixture × print+json as the
  // process-level "infrastructure, not a receipt" negative (法条③).
  for (const mode of ["print", "json"] as const) {
    const result = await runCoderSkillFailureCli(mode, "missing");
    const combined = `${result.stdout}\n${result.stderr}`;
    assertAuditAbortWithoutReceipt(result, `missing/${mode}`);
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
      const outputResults = events.filter(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "toolResult" &&
          event.message.toolName === "ak_coder_output",
      );
      assert.equal(
        outputResults.some((event) => event.message.isError === false),
        false,
        `${mode} has no accepted Coder output`,
      );
      assert.equal(
        outputResults.some((event) => event.message.details?.status !== undefined),
        false,
        `${mode} does not encode infrastructure as a receipt status`,
      );
    }
  }
});

test("installed Reviewer fatal stages abort without a receipt", async () => {
  // Process-level negative: one stage × print+json proves abort-without-receipt
  // crosses the real CLI boundary for both modes (法条③).
  const processRow = {
    stage: "audit-auth" as const,
    marker: /INJECTED_REVIEWER_AUDIT_AUTH_FAILURE/,
    calls: 1,
    tool: "ak_reviewer_output" as const,
  };
  for (const mode of ["json", "print"] as const) {
    const result = await runReviewerCli(mode, processRow.stage);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, `${processRow.stage}/${mode} subprocess did not time out`);
    assert.equal(result.code, 1, `${processRow.stage}/${mode} exits nonzero\n${combined}`);
    assert.match(combined, processRow.marker, `${processRow.stage}/${mode} reached its stage`);
    assert.match(combined, /Request was aborted|"stopReason":"aborted"/);
    assert.match(
      result.stderr,
      new RegExp(`REVIEWER_FAILURE_PROVIDER_CALLS=${processRow.calls}(?:\\D|$)`),
      `${processRow.stage}/${mode} made exactly ${processRow.calls} provider calls`,
    );
    assert.doesNotMatch(result.stdout, /Reviewer report accepted/);
    assert.doesNotMatch(combined, /FORBIDDEN INFRASTRUCTURE REFUSAL/);
    assert.doesNotMatch(combined, /FORBIDDEN LATER SUCCESS PROSE/);
    if (mode === "json") {
      const events = result.stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line));
      const erroredTool = events.find(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "toolResult" &&
          event.message.toolName === processRow.tool &&
          event.message.isError === true,
      );
      assert.ok(erroredTool, `${processRow.stage} marks ${processRow.tool} isError:true`);
      assert.ok(
        events.some(
          (event) =>
            event.type === "message_end" &&
            event.message?.role === "assistant" &&
            event.message.stopReason === "aborted",
        ),
      );
    }
  }

  // Remaining stage × call-count × isError matrix: shared template + one JSON
  // process each (template cp replaces per-row git clone). Full 4×2 matrix was
  // the expensive construction; stage markers + call counts stay process-proved.
  const matrix: Array<{
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
  for (const row of matrix) {
    const result = await runReviewerCli("json", row.stage);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 1, `${row.stage} exits nonzero\n${combined}`);
    assert.match(combined, row.marker, `${row.stage} reached its stage`);
    assert.match(
      result.stderr,
      new RegExp(`REVIEWER_FAILURE_PROVIDER_CALLS=${row.calls}(?:\\D|$)`),
    );
    assert.doesNotMatch(result.stdout, /Reviewer report accepted/);
    const events = result.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "toolResult" &&
          event.message.toolName === row.tool &&
          event.message.isError === true,
      ),
      `${row.stage} marks ${row.tool} isError:true`,
    );
  }
});

test("Reviewer fatal audit stages fail closed in-process without a receipt", async () => {
  // Cheaper in-process seam for the audit-stage family: same role-runtime path,
  // no CLI boot / no fresh git clone per row.
  await withHermeticHome({ prefix: "ak-reviewer-fatal-inproc-" }, async ({ home, agentDir }) => {
    const { path: canonicalSkillPath } = await writeTestSkill(home, "code-review");
    await writeFile(
      canonicalSkillPath,
      await readFile(resolve(packageRoot, "test/fixtures/canonical-code-review-SKILL.md")),
    );
    const cwd = resolve(home, "review-target");
    await materializeReviewerTarget(cwd);
    const taskPath = resolve(cwd, "test/fixtures/reviewer-task.md");
    const taskBytes = await readFile(taskPath);
    const capabilityPath = resolve(home, "reviewer-capabilities.json");
    await writeFile(
      capabilityPath,
      JSON.stringify({
        version: 1,
        taskSha256: createHash("sha256").update(taskBytes).digest("hex"),
        tools: ["read", "bash"],
        prerequisiteOperations: [
          "preflight.git.pin-target",
          "preflight.git.resolve-base",
          "preflight.git.derive-range",
          "preflight.git.list-ordered-commits",
          "preflight.git.read-material",
          "runner.git.materialize-mirror",
          "runner.git.materialize-workspace",
          "runner.git.verify-snapshot",
        ],
      }),
    );

    for (const stage of ["audit-auth", "audit-malformed-decision"] as const) {
      const previous = process.env.AK_REVIEWER_FAILURE_STAGE;
      const previousExitCode = process.exitCode;
      process.env.AK_REVIEWER_FAILURE_STAGE = stage;
      try {
        const faux = fauxProvider({
          api: "ak-reviewer-failure-inproc",
          provider: "ak-reviewer-failure-inproc",
          tokenSize: { min: 1000, max: 1000 },
        });
        // Drive the same fatal output call the CLI fixture uses; audit injection
        // still comes from the staged failure extension below.
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              REVIEWER_OUTPUT_TOOL_NAME,
              {
                status: "refused",
                diagnostic:
                  "The requested review cannot proceed because its runtime stage failed.",
              },
              { id: "fatal-reviewer-output" },
            ),
            { stopReason: "toolUse" },
          ),
          stage === "audit-malformed-decision"
            ? fauxAssistantMessage("MALFORMED_REVIEWER_AUDIT_DECISION_STAGE")
            : async () => {
                throw new Error("INJECTED_REVIEWER_AUDIT_AUTH_FAILURE");
              },
          fauxAssistantMessage("FORBIDDEN LATER SUCCESS PROSE"),
        ]);

        let sawError = false;
        await withInProcessPi(
          {
            cwd,
            agentDir: resolve(agentDir, stage),
            faux,
            modelsPath: null,
            additionalExtensionPaths: [
              resolve(packageRoot, "extensions/role-runtime.ts"),
            ],
            additionalSkillPaths: [canonicalSkillPath],
            noExtensions: true,
            systemPrompt: "REVIEWER FATAL INPROC",
            mode: "print",
            flags: {
              "ak-role": "reviewer",
              "ak-review-task": taskPath,
              "ak-review-capabilities": capabilityPath,
            },
            reviewerShutdown: true,
            extensionFactories: [
              (pi) => {
                pi.on("tool_call", (event, ctx) => {
                  if (
                    stage === "audit-auth" &&
                    event.toolName === REVIEWER_OUTPUT_TOOL_NAME
                  ) {
                    (ctx.modelRegistry as any).getProviderAuth = async () => {
                      throw new Error("INJECTED_REVIEWER_AUDIT_AUTH_FAILURE");
                    };
                  }
                });
              },
            ],
          },
          async ({ session, sessionManager }) => {
            try {
              await session.prompt("Review.");
            } catch {
              sawError = true;
            }
            const results = sessionManager
              .getEntries()
              .filter(
                (entry) =>
                  entry.type === "message" && entry.message.role === "toolResult",
              ) as Array<{ message: { toolName?: string; isError?: boolean; details?: any } }>;
            const output = results.find(
              (entry) => entry.message.toolName === REVIEWER_OUTPUT_TOOL_NAME,
            );
            // Gate negative: no accepted Reviewer receipt.
            if (output !== undefined) {
              assert.notEqual(output.message.isError, false);
              assert.equal(output.message.details?.status === "completed", false);
            }
            assert.ok(
              sawError ||
                output?.message.isError === true ||
                results.some((entry) => entry.message.isError === true),
              `${stage} must fail closed without an accepted receipt`,
            );
          },
        );
      } finally {
        // Production print/json audit failure sets process.exitCode = 1; restore so
        // the in-process host test file does not inherit a failing exit status.
        process.exitCode = previousExitCode;
        if (previous === undefined) delete process.env.AK_REVIEWER_FAILURE_STAGE;
        else process.env.AK_REVIEWER_FAILURE_STAGE = previous;
      }
    }
  });
});
