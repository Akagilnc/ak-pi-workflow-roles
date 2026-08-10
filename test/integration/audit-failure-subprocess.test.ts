import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { resolveBookKeyFromGit } from "../../src/activation-ledger.ts";
import { runFixerAuditFailureCli } from "../helpers/fixer-audit-cli.ts";
import {
  packageRoot,
  runPiSubprocess,
  withActivationHome,
  withHermeticHome,
  withInProcessPi,
  writeTestSkill,
} from "../helpers/pi-test-harness.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/role-runtime.ts";

async function runCli(mode: "print" | "json") {
  return withHermeticHome(
    { prefix: "ak-audit-cli-" },
    async ({ home, agentDir }) => {
      const sessionDirectory = resolve(
        home,
        ".ak-roles/books",
        resolveBookKeyFromGit(packageRoot),
        "runs/audit-cli/session",
      );
      await mkdir(sessionDirectory, { recursive: true });
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

async function runHealthyNavigatorAuditFailureCli(mode: "print" | "json") {
  return withActivationHome(
    { prefix: "ak-audit-navigator-" },
    async ({ home, agentDir }) => {
      const issueRoot = resolve(home, ".ak/work/issues/28");
      await mkdir(issueRoot, { recursive: true });
      // Role session under ledger book; Navigator subject still derives from issueRoot cwd.
      const sessionDirectory = resolve(
        home,
        ".ak-roles",
        "books",
        basename(home),
        "runs",
        "judge-navigator",
        "session",
      );
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
          AK_ROLE_SESSION_DIR: sessionDirectory,
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
      const base = execFileSync("git", ["rev-parse", "HEAD~1"], {
        cwd,
        encoding: "utf8",
      }).trim();
      const sessionDirectory = resolve(home, ".ak-roles/books/review-target/runs/reviewer-fatal/session");
      await mkdir(sessionDirectory, { recursive: true });
      const args = [
        "--no-extensions",
        "--no-skills",
        "--skill",
        canonicalSkillPath,
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--session-dir",
        sessionDirectory,
        "-e",
        resolve(packageRoot, "extensions/role-runtime.ts"),
        "-e",
        resolve(packageRoot, "test/fixtures/reviewer-failure-provider.ts"),
        "--ak-role",
        "reviewer",
        "--ak-review-base",
        base,
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
      const sessionDirectory = resolve(
        home,
        ".ak-roles/books",
        resolveBookKeyFromGit(packageRoot),
        "runs/coder-skill-fatal/session",
      );
      await mkdir(sessionDirectory, { recursive: true });
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
}

function jsonEvents(stdout: string): any[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as any);
}

function assertJsonAbortFacts(
  result: { stdout: string; stderr: string },
  toolName: string,
  label: string,
  requireAborted = true,
) {
  const events = jsonEvents(result.stdout);
  assert.equal(
    events.some(
      (event) =>
        event.type === "message_end" &&
        event.message?.role === "toolResult" &&
        event.message.toolName === toolName &&
        event.message.isError === true,
    ),
    true,
    `${label} emits an errored ${toolName} result`,
  );
  if (requireAborted) {
    assert.equal(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "assistant" &&
          event.message.stopReason === "aborted",
      ),
      true,
      `${label} stops with typed aborted reason`,
    );
  }
}

test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runCli(mode);
    assertAuditAbortWithoutReceipt(result, mode);
    if (mode === "json") {
      assertJsonAbortFacts(result, "ak_judge_output", mode);
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
    // Shared lifecycle persists the typed infra fact so exact-session restart
    // classifies this terminal as durable completion (not a retryable isError).
    details: {
      kind: "role_infrastructure_failure",
      source: "shared-role-lifecycle",
      reasonCode: "host_failure",
    },
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
  // JSON stream emits message_end with role=custom; session principal uses custom_message.
  const attendance = events.filter(
    (event) =>
      (event.type === "message_end" &&
        event.message?.role === "custom" &&
        event.message?.customType === "ak-navigator-attendance") ||
      (event.type === "custom_message" && event.customType === "ak-navigator-attendance"),
  );
  assert.equal(attendance.length, 1, "infrastructure failure emits affirmative typed no-advice");
  assert.equal(
    attendance[0]?.message?.details?.disposition ?? attendance[0]?.details?.disposition,
    "no-advice",
  );
});

test("fatal Fixer audit infrastructure failure aborts print and JSON without a receipt", async () => {
  // Fixer-specific process proof (distinct from the Judge survivor): exit code +
  // typed isError/stopReason on ak_fixer_output.
  for (const mode of ["print", "json"] as const) {
    const result = await runFixerAuditFailureCli({ mode });
    assertAuditAbortWithoutReceipt(result, `fixer/${mode}`);
    if (mode === "json") {
      assertJsonAbortFacts(result, "ak_fixer_output", mode);
    }
  }
});

test("coder apply without skill expansion rejects completed as non-receipt", async () => {
  // #109: TDD is package-owned (empty home is fine). Process-level negative keeps
  // the typed Skill-expansion gate: completed without native expansion must not
  // become an accepted receipt (法条③ / AC3).
  for (const mode of ["print", "json"] as const) {
    const result = await runCoderSkillFailureCli(mode, "missing");
    assert.equal(result.timedOut, false, `${mode} did not time out`);
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
        outputResults.some((event) => event.message.isError === true),
        true,
        `${mode} records the rejected completed submission`,
      );
      assert.equal(
        outputResults.some(
          (event) =>
            event.message.isError === false &&
            event.message.details?.status !== undefined,
        ),
        false,
        `${mode} does not encode gate failure as a receipt status`,
      );
    } else {
      // print mode: stderr observation face records only errored coder tool ends.
      const ends = [
        ...result.stderr.matchAll(
          /"toolName":"ak_coder_output","timestamp":"[^"]+","isError":(true|false)/g,
        ),
      ];
      assert.ok(ends.length > 0, "print mode emits coder tool_execution_end");
      assert.equal(
        ends.every((match) => match[1] === "true"),
        true,
        "print mode has no accepted coder tool_execution_end",
      );
    }
  }
});

test("installed Reviewer fatal stages abort without a receipt", async () => {
  // Process-level negative: one stage × print+json proves abort-without-receipt
  // crosses the real CLI boundary for both modes (法条③).
  const processRow = {
    stage: "audit-auth" as const,
    tool: "ak_reviewer_output" as const,
  };
  for (const mode of ["json", "print"] as const) {
    const result = await runReviewerCli(mode, processRow.stage);
    assert.equal(result.timedOut, false, `${processRow.stage}/${mode} subprocess did not time out`);
    assert.equal(result.code, 1, `${processRow.stage}/${mode} exits nonzero`);
    if (mode === "json") {
      assertJsonAbortFacts(result, processRow.tool, `${processRow.stage}/${mode}`);
    }
  }

  // Remaining stages: shared template + one JSON process each (template cp
  // replaces per-row git clone). Assert exit code + typed isError/stopReason.
  const matrix: Array<{
    stage: ReviewerFailureStage;
    tool: "Agent" | "ak_reviewer_output";
  }> = [
    { stage: "preflight-git", tool: "ak_reviewer_output" },
    { stage: "audit-provider", tool: "ak_reviewer_output" },
    { stage: "audit-malformed-decision", tool: "ak_reviewer_output" },
  ];
  for (const row of matrix) {
    const result = await runReviewerCli("json", row.stage);
    assert.equal(result.code, 1, `${row.stage} exits nonzero`);
    assertJsonAbortFacts(result, row.tool, row.stage, row.stage !== "preflight-git");
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
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd,
      encoding: "utf8",
    }).trim();

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
          fauxAssistantMessage("Independent standards review found no findings."),
          fauxAssistantMessage("Independent spec review found no findings."),
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
            activationLedgerSession: true,
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
              "ak-review-base": base,
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
