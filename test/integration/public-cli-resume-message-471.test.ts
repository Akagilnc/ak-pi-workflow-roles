/**
 * #471 resume carries opaque message — public entry seam.
 * Seams: runAkRole(["resume", runId, message?]) → injected piRunner argv.
 * Assert session identity + last argv equality only; never lock help prose.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/package-contracts/worker-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-471-resume-msg-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (t: string) => {
        stdout.push(t);
      },
      stderr: (t: string) => {
        stderr.push(t);
      },
    },
  };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "471@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "471"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function materializeConflictedRepo(root: string): Promise<void> {
  seedGitProject(root);
  await writeFile(join(root, "same.txt"), "base\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["checkout", "-b", "source"]);
  await writeFile(join(root, "same.txt"), "source\n", "utf8");
  git(root, ["commit", "-am", "source"]);
  git(root, ["checkout", "main"]);
  await writeFile(join(root, "same.txt"), "target\n", "utf8");
  git(root, ["commit", "-am", "target"]);
  try {
    git(root, ["merge", "--no-edit", "source"]);
    throw new Error("expected conflicting merge");
  } catch {
    // conflicted working tree required for merger admit
  }
}

function toolResultLine(toolName: string, details: unknown): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      toolName,
      isError: false,
      details,
    },
  })}\n`;
}

function lawfulReviewerDetails() {
  const axes = ["standards"] as const;
  const skillText = "package code-review skill body\n";
  const prompt = (axis: string) => ({ text: `${axis} prompt\n` });
  return {
    version: 2 as const,
    status: "completed" as const,
    acceptedBatch: {
      identity: "dispatch",
      legs: axes.map((axis) => ({ axis, prompt: prompt(axis) })),
    },
    reports: Object.fromEntries(axes.map((axis) => [axis, { text: `${axis} report` }])),
    outcomes: Object.fromEntries(
      axes.map((axis) => [
        axis,
        {
          status: "successful",
          prompt: prompt(axis),
          workspaceDisposition: "deleted",
        },
      ]),
    ),
    identities: {
      canonicalSkill: { text: skillText },
      construction: { recipe: "reviewer-common-bundle-v1" },
      target: {
        repositoryRoot: "/repo",
        objectFormat: "sha1",
        targetHead: "a".repeat(40),
        refs: {
          tag: { objectId: "b".repeat(40), peeledCommitId: null },
        },
      },
    },
  };
}

type DurableRole = "judge" | "coder" | "fixer" | "reviewer" | "merger";

type RoleCase = {
  readonly role: DurableRole;
  readonly runId: string;
  readonly message?: string;
  readonly label: string;
};

const MESSAGE_CASES: readonly RoleCase[] = [
  { role: "judge", runId: "471-judge-plain", message: "owner says proceed", label: "judge plain message" },
  { role: "judge", runId: "471-judge-flagish", message: "--model", label: "judge opaque --model token" },
  { role: "judge", runId: "471-judge-empty", message: "", label: "judge empty string message" },
  {
    role: "judge",
    runId: "471-judge-ws",
    message: "  ruling with\nnewline  ",
    label: "judge whitespace/newline message",
  },
  { role: "coder", runId: "471-coder-plain", message: "coder owner note", label: "coder plain message" },
  { role: "fixer", runId: "471-fixer-plain", message: "fixer owner note", label: "fixer plain message" },
  {
    role: "reviewer",
    runId: "471-reviewer-plain",
    message: "reviewer owner note",
    label: "reviewer plain message",
  },
  { role: "merger", runId: "471-merger-plain", message: "merger owner note", label: "merger plain message" },
  { role: "judge", runId: "471-judge-bare", label: "judge bare resume keeps envelope" },
];

async function admitDurableRun(input: {
  home: string;
  project: string;
  role: DurableRole;
  runId: string;
}): Promise<{ sessionFile: string; sessionDirectory: string }> {
  const { home, project, role, runId } = input;
  const instruction = `admit ${role} for #471`;
  const admitArgs: string[] =
    role === "judge"
      ? ["judge", "--project", project, instruction]
      : role === "coder"
        ? ["coder", "plan", "--project", project, instruction]
        : role === "fixer"
          ? ["fixer", "plan", "--project", project, instruction]
          : role === "reviewer"
            ? ["reviewer", "--project", project, "--base", "main", instruction]
            : ["merger", "--project", project, instruction];

  const { io } = captureIo();
  const first = await runAkRole(admitArgs, {
    packageRoot,
    home,
    cwd: project,
    credentials: { "openai-codex": true, xai: true },
    createRunId: () => runId,
    io,
    piRunner: async (args) => {
      const sessionDir = args[args.indexOf("--session-dir") + 1]!;
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
      await observeTyped429ViaProductionHandler({
        runDirectory: join(sessionDir, ".."),
        provider: "xai",
      });
      return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
    },
  });
  assert.ok(first.terminal?.resume, `${role} admit must be resumable`);

  const bookKey = resolveBookKeyFromGit(project);
  const runDirectory = join(
    home,
    ".ak-roles",
    "books",
    bookKey,
    "runs",
    `${runId}@${role}`,
  );
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = join(sessionDirectory, "session.jsonl");
  return { sessionFile, sessionDirectory };
}

function writeResumeReceipt(role: DurableRole, runId: string): string {
  switch (role) {
    case "judge":
      return toolResultLine(JUDGE_OUTPUT_TOOL_NAME, { judgeStatus: "converged" });
    case "coder":
      return toolResultLine(CODER_OUTPUT_TOOL_NAME, {
        status: "planned",
        report: "resumed coder plan",
      });
    case "fixer":
      return toolResultLine(FIXER_OUTPUT_TOOL_NAME, {
        status: "planned",
        report: "resumed fixer plan",
      });
    case "reviewer":
      return toolResultLine(REVIEWER_OUTPUT_TOOL_NAME, lawfulReviewerDetails());
    case "merger":
      return toolResultLine(MERGER_OUTPUT_TOOL_NAME, {
        status: "escalate",
        attemptId: runId,
        diagnosis: "still needs authority",
        report: "resumed merger escalate",
      });
  }
}

test("#471 table: resume message is last argv for five durable roles", async () => {
  await withTempHome(async (home) => {
    for (const scenario of MESSAGE_CASES) {
      const project = join(home, `work-${scenario.runId}`);
      await mkdir(project, { recursive: true });
      if (scenario.role === "merger") {
        await materializeConflictedRepo(project);
      } else {
        seedGitProject(project);
      }

      const admitted = await admitDurableRun({
        home,
        project,
        role: scenario.role,
        runId: scenario.runId,
      });

      const resumeArgv =
        scenario.message === undefined
          ? (["resume", scenario.runId] as string[])
          : (["resume", scenario.runId, scenario.message] as string[]);

      const { io, stderr } = captureIo();
      let resumeArgs: string[] | undefined;
      await runAkRole(resumeArgv, {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io,
        piRunner: async (args) => {
          resumeArgs = [...args];
          await writeFile(
            admitted.sessionFile,
            writeResumeReceipt(scenario.role, scenario.runId),
            "utf8",
          );
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
      });

      // #471 table contract is transport only: exact session reopen + last argv.
      assert.ok(
        resumeArgs,
        `${scenario.label}: piRunner must dispatch; err=${stderr.join("")}`,
      );
      assert.equal(
        resumeArgs[resumeArgs.indexOf("--session") + 1],
        admitted.sessionFile,
        `${scenario.label}: exact --session`,
      );
      assert.equal(
        resumeArgs[resumeArgs.indexOf("--session-dir") + 1],
        admitted.sessionDirectory,
        `${scenario.label}: exact --session-dir`,
      );
      const expectedLast =
        scenario.message === undefined ? RESUME_TRANSPORT_ENVELOPE : scenario.message;
      assert.equal(
        resumeArgs.at(-1),
        expectedLast,
        `${scenario.label}: last argv must equal continuation prompt`,
      );
    }
  });
});

test("#471 tracer: judge escalate → owner message resume → same session converged", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "work-escalate");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "471-judge-escalate-feed";
    const ownerRuling = "Owner rules: accept the plan and converge.";

    let firstSessionFile = "";
    let firstSessionDir = "";
    {
      const { io } = captureIo();
      const first = await runAkRole(
        ["judge", "--project", project, "Need a human decision on scope."],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          piRunner: async (args) => {
            firstSessionDir = args[args.indexOf("--session-dir") + 1]!;
            firstSessionFile = args[args.indexOf("--session") + 1]!;
            await mkdir(firstSessionDir, { recursive: true });
            await writeFile(
              firstSessionFile,
              toolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
                judgeStatus: "escalate",
                decisionGate: {
                  question: "Accept plan?",
                  options: ["accept", "reject"],
                },
              }),
              "utf8",
            );
            return { code: 0, stderr: "", timedOut: false, args: [...args] };
          },
        },
      );
      assert.equal(first.exitCode, 0);
      assert.equal(first.terminal?.roleOutcome.role, "judge");
      assert.equal(
        first.terminal?.roleOutcome.kind === "accepted"
          ? first.terminal.roleOutcome.status
          : undefined,
        "escalate",
      );
    }

    const { io, stdout, stderr } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", runId, ownerRuling], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      piRunner: async (args) => {
        resumeArgs = [...args];
        await writeFile(
          firstSessionFile,
          toolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
            judgeStatus: "converged",
            note: "owner ruling applied",
          }),
          "utf8",
        );
        return { code: 0, stderr: "", timedOut: false, args: [...args] };
      },
    });

    assert.equal(
      resumed.exitCode,
      0,
      `resume exit; out=${stdout.join("")}; err=${stderr.join("")}`,
    );
    assert.ok(resumeArgs);
    assert.equal(resumeArgs[resumeArgs.indexOf("--session") + 1], firstSessionFile);
    assert.equal(resumeArgs[resumeArgs.indexOf("--session-dir") + 1], firstSessionDir);
    assert.equal(resumeArgs.at(-1), ownerRuling);
    assert.equal(resumed.terminal?.roleOutcome.role, "judge");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "converged",
    );
  });
});
