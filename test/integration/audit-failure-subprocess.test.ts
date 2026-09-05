import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test, { after } from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger.ts";
import {
  packageRoot,
  runPiSubprocess,
  withActivationHome,
  withHermeticHome,
} from "../helpers/pi-test-harness.ts";
import { resolvePackagedMethodSkillPath } from "../../src/package-resources/method-skill.ts";
import { writeInstitutionalSeatTable, seatSelection } from "../helpers/institutional-seat-table.ts";

async function runCli(mode: "print" | "json") {
  return withHermeticHome(
    { prefix: "ak-audit-cli-" },
    async ({ home, agentDir }) => {
      const runDir = resolve(
        home,
        ".ak-roles/books",
        resolveBookKeyFromGit(packageRoot),
        "runs/audit-cli",
      );
      const sessionDirectory = resolve(runDir, "session");
      await mkdir(sessionDirectory, { recursive: true });
      await writeInstitutionalSeatTable(runDir, {
        gatekeeper: seatSelection("ak-audit-failure", "faux-1"),
        notary: seatSelection("ak-audit-failure", "faux-1"),
        auditor: seatSelection("ak-audit-failure", "faux-1"),
      });
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
      const runDir = resolve(
        home,
        ".ak-roles",
        "books",
        basename(home),
        "runs",
        "judge-navigator",
      );
      const sessionDirectory = resolve(runDir, "session");
      await mkdir(sessionDirectory, { recursive: true });
      await writeInstitutionalSeatTable(runDir, {
        gatekeeper: seatSelection("ak-audit-failure", "faux-1"),
        notary: seatSelection("ak-audit-failure", "faux-1"),
        auditor: seatSelection("ak-audit-failure", "faux-1"),
      });
      // The hermetic activation ledger owns Navigator records beside role runs.
      await mkdir(
        resolve(home, ".ak-roles", "books", basename(home), "navigator"),
        { recursive: true },
      );
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
          AK_ROLE_RUN_DIR: undefined,
          PI_OFFLINE: "1",
        },
      });
    },
  );
}

/** Reviewer fatal stages remaining after #495 S6 retired the reviewer-side auditor. */
type ReviewerFailureStage = "preflight-git";

/** Per-stage stderr identity — proves fail-closed came from this row's injection. */
const REVIEWER_FATAL_STAGE_MARKERS: Record<ReviewerFailureStage, RegExp> = {
  "preflight-git": /INJECTED_REVIEWER_GIT_IO_FAILURE/,
};

function assertHealthyReviewerGitTree(cwd: string, label: string): void {
  assert.equal(
    existsSync(resolve(cwd, ".git")),
    true,
    `${label}: shared review-target must keep .git`,
  );
  assert.equal(
    existsSync(resolve(cwd, ".git-injected-failure")),
    false,
    `${label}: must not carry residual .git-injected-failure poison`,
  );
}

/** preflight-git renames .git in the shared cwd; always undo before the next row. */
function restoreReviewerGitTreeAfterInjection(cwd: string): void {
  const gitDir = resolve(cwd, ".git");
  const poisoned = resolve(cwd, ".git-injected-failure");
  if (existsSync(poisoned) && !existsSync(gitDir)) {
    renameSync(poisoned, gitDir);
  } else if (existsSync(poisoned)) {
    // Both present is unexpected; drop the residual marker so later rows stay clean.
    rmSync(poisoned, { recursive: true, force: true });
  }
}

/** One shared review-target clone for the whole file — rows cp -R it. */
let reviewerTargetTemplateRoot: string | undefined;
let reviewerTargetTemplateMemo: Promise<string> | undefined;
async function reviewerTargetTemplate(): Promise<string> {
  reviewerTargetTemplateMemo ??= (async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ak-reviewer-fatal-template-"));
    reviewerTargetTemplateRoot = root;
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", packageRoot, root], {
      stdio: "ignore",
    });
    return root;
  })();
  return reviewerTargetTemplateMemo;
}

after(async () => {
  if (reviewerTargetTemplateRoot === undefined) return;
  await rm(reviewerTargetTemplateRoot, { recursive: true, force: true });
  reviewerTargetTemplateRoot = undefined;
});

async function materializeReviewerTarget(dest: string): Promise<void> {
  const template = await reviewerTargetTemplate();
  await rm(dest, { recursive: true, force: true });
  await cp(template, dest, { recursive: true });
}

type ReviewerFatalCold = {
  home: string;
  agentDir: string;
  cwd: string;
  skillPath: string;
  base: string;
};

/** One cold fixture for both installed + in-process Reviewer fatal seams. */
async function withReviewerFatalCold<T>(
  run: (cold: ReviewerFatalCold) => Promise<T>,
): Promise<T> {
  return withHermeticHome(
    { prefix: "ak-reviewer-fatal-cold-" },
    async ({ home, agentDir }) => {
      // Package-owned path only — captureExpansion rejects home copies (#binding contract).
      const skillPath = resolvePackagedMethodSkillPath(packageRoot, "code-review");
      const cwd = resolve(home, "review-target");
      await materializeReviewerTarget(cwd);
      const base = execFileSync("git", ["rev-parse", "HEAD~1"], {
        cwd,
        encoding: "utf8",
      }).trim();
      return run({ home, agentDir, cwd, skillPath, base });
    },
  );
}

async function runReviewerCliOnCold(
  cold: ReviewerFatalCold,
  mode: "print" | "json",
  stage: ReviewerFailureStage,
  label: string,
) {
  const sessionDirectory = resolve(
    cold.home,
    `.ak-roles/books/review-target/runs/reviewer-fatal-${label}/session`,
  );
  await mkdir(sessionDirectory, { recursive: true });
  const rowAgentDir = resolve(cold.agentDir, `cli-${label}`);
  await mkdir(rowAgentDir, { recursive: true });
  const args = [
    "--no-extensions",
    "--no-skills",
    "--skill",
    cold.skillPath,
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
    cold.base,
    "--provider",
    "ak-reviewer-failure",
    "--model",
    "faux-1",
    ...(mode === "print" ? ["-p", "Review."] : ["--mode", "json", "Review."]),
  ];
  return runPiSubprocess(args, {
    cwd: cold.cwd,
    env: {
      ...process.env,
      HOME: cold.home,
      AK_REVIEWER_FAILURE_STAGE: stage,
      PI_CODING_AGENT_DIR: rowAgentDir,
      PI_OFFLINE: "1",
    },
  });
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
      // Temp git worktree so production arm never mutates the real package checkout.
      const work = resolve(home, "work");
      await mkdir(work, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: work });
      execFileSync("git", ["config", "user.email", "coder-skill@test.local"], { cwd: work });
      execFileSync("git", ["config", "user.name", "Coder Skill"], { cwd: work });
      execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: work });
      const sessionDirectory = resolve(
        home,
        ".ak-roles/books",
        resolveBookKeyFromGit(work),
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
        cwd: work,
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
  result: { code: number | null; stdout: string; stderr: string; localTimeout: boolean },
  label: string,
) {
  assert.equal(result.localTimeout, false, `${label} subprocess did not time out`);
  assert.equal(result.code, 1, `${label} exits nonzero`);
}

function jsonEvents(stdout: string): any[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as any);
}

function assertJsonFailureFacts(
  result: { stdout: string; stderr: string },
  toolName: string,
  label: string,
  requireError = true,
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
  if (requireError) {
    assert.equal(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "assistant" &&
          event.message.stopReason === "error",
      ),
      true,
      `${label} stops with typed error reason`,
    );
  }
}

test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runCli(mode);
    assertAuditAbortWithoutReceipt(result, mode);
    if (mode === "json") {
      assertJsonFailureFacts(result, "ak_judge_output", mode);
    }
  }
});

// #675: nested public auditor summons change offline no-receipt subprocess shape.
test.skip("no-receipt Judge audit drains one healthy packaged Navigator for the accepted parent", async () => {
  // Process boundary required: process-release evidence is emitted on process exit.
  const result = await runHealthyNavigatorAuditFailureCli("json");
  assert.equal(result.localTimeout, false, "subprocess did not time out");
  // Malformed auditor prose is absence of an accepted receipt under #288, not
  // infrastructure failure; the parent candidate remains lawful and exits zero.
  assert.equal(result.code, 0, "typed no-receipt audit leg does not扣押 the parent candidate");
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
        usage?: { totalTokens: number };
      };
      failedOutputAt: string;
      failedOutputCorrelation: boolean;
      closureDetails: Record<string, unknown>;
    };
  };
  assert.equal(evidence.navigatorCalls, 1);
  assert.equal(evidence.navigator.settlementKind, "accepted");
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
  assert.equal(evidence.role.failedOutput.toolCallId, "fatal-judge");
  assert.equal(evidence.role.failedOutput.toolName, "ak_judge_output");
  assert.equal(evidence.role.failedOutput.isError, false);
  assert.deepEqual(evidence.role.failedOutput.details, { submissionDisposition: "pending-round-closure" });
  assert.equal(evidence.role.closureDetails.judgeStatus, "converged");
  const auditNoReceipt = evidence.role.closureDetails.auditNoReceipt as {
    acceptedReceipt: boolean;
    deliveryTurns: number;
    terminalToolCalled: boolean;
    rejectedReceipts: readonly { reason: string }[];
    runPointer: string;
    attemptPointer: string;
    usage?: { totalTokens: number };
  };
  assert.equal(auditNoReceipt.acceptedReceipt, false);
  assert.equal(auditNoReceipt.deliveryTurns, 2);
  assert.equal(auditNoReceipt.terminalToolCalled, false);
  assert.deepEqual(auditNoReceipt.rejectedReceipts, []);
  assert.match(auditNoReceipt.runPointer, /judge-navigator/);
  assert.notEqual(auditNoReceipt.attemptPointer, "");
  assert.ok((auditNoReceipt.usage?.totalTokens ?? 0) > 0, "measured audit usage reaches the sealed Judge submission");
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
  assert.equal(failedOutputs.length, 1, "must report exactly the Judge output call");
  assert.equal(failedOutputs[0].message.isError, false);
  // JSON stream emits message_end with role=custom; session principal uses custom_message.
  const attendance = events.filter(
    (event) =>
      (event.type === "message_end" &&
        event.message?.role === "custom" &&
        event.message?.customType === "ak-navigator-attendance") ||
      (event.type === "custom_message" && event.customType === "ak-navigator-attendance"),
  );
  assert.equal(attendance.length, 1, "accepted parent emits one typed Navigator attendance");
  assert.equal(
    attendance[0]?.message?.details?.disposition ?? attendance[0]?.details?.disposition,
    "recommendation",
  );
});

test("coder apply without skill expansion rejects completed as non-receipt", async () => {
  // #109: TDD is package-owned (empty home is fine). Process-level negative keeps
  // the typed Skill-expansion gate: completed without native expansion must not
  // become an accepted receipt (法条③ / AC3).
  for (const mode of ["print", "json"] as const) {
    const result = await runCoderSkillFailureCli(mode, "missing");
    assert.equal(result.localTimeout, false, `${mode} did not time out`);
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

test("Reviewer fatal stages abort without a receipt on installed seams", async () => {
  // #319 Batch 3 (M4) residual after #495 S6: preflight-git only (auditor stages retired).
  await withReviewerFatalCold(async (cold) => {
    const rows: Array<{ mode: "json" | "print"; stage: ReviewerFailureStage; tool: "ak_reviewer_output" }> = [
      { mode: "json", stage: "preflight-git", tool: "ak_reviewer_output" },
      { mode: "print", stage: "preflight-git", tool: "ak_reviewer_output" },
    ];

    for (const row of rows) {
      const label = `${row.stage}-${row.mode}`;
      assertHealthyReviewerGitTree(cold.cwd, `before ${label}`);
      try {
        const result = await runReviewerCliOnCold(cold, row.mode, row.stage, label);
        assert.equal(result.localTimeout, false, `${label} subprocess did not time out`);
        assert.equal(result.code, 1, `${label} exits nonzero`);
        assert.match(
          `${result.stderr}\n${result.stdout}`,
          REVIEWER_FATAL_STAGE_MARKERS[row.stage],
          `${label} must fail closed from its own ${row.stage} injection, not residual poison`,
        );
        if (row.mode === "json") {
          // Preflight aborts at activate/git pin — before any output tool — so
          // the no-receipt proof is exit 1 + own injection marker + zero accepted receipt.
          const events = jsonEvents(result.stdout);
          assert.equal(
            events.some(
              (event) =>
                event.type === "message_end" &&
                event.message?.role === "toolResult" &&
                event.message.toolName === row.tool &&
                event.message.isError === false,
            ),
            false,
            `${label} must not accept a ${row.tool} receipt`,
          );
        }
      } finally {
        restoreReviewerGitTreeAfterInjection(cold.cwd);
        assertHealthyReviewerGitTree(cold.cwd, `after ${label} restore`);
      }
    }
  });
});
