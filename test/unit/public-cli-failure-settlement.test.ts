/**
 * #107 failure + human-decision settlement seam.
 * Seams: parseJudgeArgv / admitJudgeInvocation / settleJudge* /
 * runAkRole(judge) with injectable Pi runner / TerminalResult typed owners.
 * Assert typed regions, emission count, durability, exit — never table labels/layout.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDIT_ESCALATION_KIND } from "../../src/audit-escalation.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  classifyPostAdmissionFailure,
  exitCodeForTerminalOutcome,
  extractJudgeRoleOutcome,
  formatFailureStderrDiagnostic,
  isLawfulTypedTerminalOutcome,
  settleJudgeFailureTerminalResult,
  settleJudgeTerminalResult,
} from "../../src/public-cli/settlement.ts";
import type { ControlledFailureCause } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-fail-"));
  try {
    return await scenario(home);
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
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fail@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fail Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function floodStderr(): string {
  return [
    "event: tool_call",
    "event: token delta x".repeat(40),
    "Error: provider boom",
    "    at Object.fn (vendor/stack.js:1:1)",
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "tokens=999999 tool_calls=42",
  ].join("\n");
}

test("malformed CLI structure rejects before admission with no model dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    let ran = false;
    const result = await runAkRole(
      ["judge", "--not-a-real-flag", "task", "--project", project],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        piRunner: async (args) => {
          ran = true;
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(ran, false);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length >= 1, true);
    // No Role run ledger directory created for structural reject.
    await assert.rejects(
      () => access(join(home, ".ak-roles")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });
});

test("well-formed nonexistent domain facts are not semantically pre-rejected", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    let dispatchedPrompt: string | undefined;
    const domainProse =
      "Adjudicate missing issue #999999 and absent PR https://example.invalid/x/y/pull/404 with no local authority.";

    const result = await runAkRole(
      ["judge", "--project", project, domainProse],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-domain-001",
        io,
        piRunner: async (args) => {
          dispatchedPrompt = String(args.at(-1));
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { judgeStatus: "converged", note: "domain remains role-owned" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(dispatchedPrompt, domainProse);
    assert.equal(stdout.length, 1);
  });
});

test("classifyPostAdmissionFailure retains typed causes without washing identity", () => {
  assert.deepEqual(
    classifyPostAdmissionFailure({ timedOut: true, code: null, stderr: floodStderr() }),
    {
      cause: "timeout",
      diagnostic: "judge role run timed out",
      details: { timedOut: true, code: null },
    },
  );

  const activation = classifyPostAdmissionFailure({
    timedOut: false,
    code: 1,
    stderr: floodStderr(),
  });
  assert.equal(activation.cause, "activation");
  assert.equal(activation.diagnostic.includes("provider boom"), true);
  assert.equal(activation.diagnostic.includes("at Object.fn"), false);
  assert.equal(activation.diagnostic.includes("tokens="), false);

  const missing = classifyPostAdmissionFailure({
    timedOut: false,
    code: 0,
    stderr: "",
  });
  assert.equal(missing.cause, "output");

  const original = new Error("socket hang up");
  original.name = "ProviderTransportError";
  const unrecognized = classifyPostAdmissionFailure({
    timedOut: false,
    code: null,
    stderr: "",
    thrown: original,
  });
  assert.equal(unrecognized.cause, "unrecognized");
  assert.equal(unrecognized.diagnostic, "socket hang up");
  assert.equal(unrecognized.identity?.name, "ProviderTransportError");
});

test("failure settlement durably records Error Artifact before presentation returns", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const runId = "run-fail-durable-001";
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const admitted = {
      role: "judge" as const,
      runId,
      bookKey,
      projectRoot: project,
      instruction: "x",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      sessionDirectory: join(runDirectory, "session"),
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
    };
    await writeFile(admitted.admittedRequestPath, "{}\n", "utf8");

    const failure = classifyPostAdmissionFailure({
      timedOut: false,
      code: 1,
      stderr: "provider rejected credentials\n",
    });
    const terminal = await settleJudgeFailureTerminalResult(admitted, failure);

    // Durability before caller presentation: artifact paths already openable.
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind !== "failure") throw new Error("expected failure");
    assert.equal(terminal.roleOutcome.cause, "activation");
    assert.equal(terminal.roleOutcome.diagnostic.includes("provider rejected credentials"), true);
    assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
    assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);

    const errorRef = terminal.artifacts.find((a) => a.kind === "error");
    assert.ok(errorRef);
    const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      runId: string;
      role: string;
    };
    assert.equal(errorBody.cause, "activation");
    assert.equal(errorBody.diagnostic, terminal.roleOutcome.diagnostic);
    assert.equal(errorBody.runId, runId);
    assert.equal(errorBody.role, "judge");
    assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
    assert.equal(terminal.navigator.disposition, "no-advice");
  });
});

test("controlled failure emits one stdout Terminal and one concise stderr diagnostic", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();

    const result = await runAkRole(
      ["judge", "--project", project, "task that will fail activation"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-fail-emit-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          // No lawful terminal result in session.
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stdout: "event flood\n".repeat(100),
            stderr: floodStderr(),
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(typeof stdout[0], "string");
    assert.ok((stdout[0] ?? "").length > 0);
    assert.equal(stderr.length, 1);
    const diagnostic = stderr[0]!;
    assert.equal(diagnostic.includes("at Object.fn"), false);
    assert.equal(diagnostic.includes("event:"), false);
    assert.equal(diagnostic.includes("tokens="), false);
    // Concise: single diagnostic write, not a multi-frame stack dump.
    assert.equal(diagnostic.split("\n").filter((line) => line.trim() !== "").length, 1);

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-fail-emit-001@judge",
    );
    const errorPath = join(runDir, "artifacts", "error.json");
    const errorBody = JSON.parse(await readFile(errorPath, "utf8")) as {
      cause: string;
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "activation");
    assert.equal(errorBody.diagnostic.length > 0, true);
  });
});

test("audit_escalation is a lawful typed terminal result exiting zero without becoming a Receipt", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();

    const escalation = {
      kind: AUDIT_ESCALATION_KIND,
      conflicts: ["soul procedure conflict"],
      decisionGate: {
        question: "Which authority controls this gate?",
        options: ["owner", "caller"],
      },
    };

    const result = await runAkRole(
      ["judge", "--project", project, "needs human decision"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-escalation-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: escalation,
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 0);

    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-escalation-001@judge",
    );
    const terminal = await settleJudgeTerminalResult({
      role: "judge",
      runId: "run-escalation-001",
      runDirectory: runDir,
      sessionDirectory: join(runDir, "session"),
      projectRoot: project,
      bookKey,
      instruction: "needs human decision",
      instructionEmpty: false,
      attachments: [],
      admittedRequestPath: join(runDir, "admitted-request.json"),
    });
    assert.equal(terminal.roleOutcome.kind, "audit_escalation");
    if (terminal.roleOutcome.kind !== "audit_escalation") {
      throw new Error("expected audit_escalation");
    }
    assert.equal(terminal.roleOutcome.status, "audit_escalation");
    assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), true);
    assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 0);
    // Not relabeled as an accepted role Receipt.
    assert.equal(
      terminal.roleOutcome.decisiveFacts.kind,
      AUDIT_ESCALATION_KIND,
    );
  });
});

test("lawful judge escalate human-decision exits zero as accepted role outcome", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "needs owner decision"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-escalate-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: {
                  judgeStatus: "escalate",
                  decisionGate: {
                    question: "Ship or hold?",
                    options: ["ship", "hold"],
                  },
                },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    const bookKey = resolveBookKeyFromGit(project);
    const runDir = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-escalate-001@judge",
    );
    const terminal = await settleJudgeTerminalResult({
      role: "judge",
      runId: "run-escalate-001",
      runDirectory: runDir,
      sessionDirectory: join(runDir, "session"),
      projectRoot: project,
      bookKey,
      instruction: "needs owner decision",
      instructionEmpty: false,
      attachments: [],
      admittedRequestPath: join(runDir, "admitted-request.json"),
    });
    assert.equal(terminal.roleOutcome.kind, "accepted");
    if (terminal.roleOutcome.kind !== "accepted") throw new Error("expected accepted");
    assert.equal(terminal.roleOutcome.status, "escalate");
    assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 0);
  });
});

test("no lawful typed terminal result exits nonzero; unrecognized keeps identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();

    const result = await runAkRole(
      ["judge", "--project", project, "will throw"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-unrec-001",
        io,
        piRunner: async () => {
          const err = new Error("ECONNRESET from upstream");
          err.name = "RawSocketError";
          throw err;
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.equal(stderr[0]!.includes("ECONNRESET from upstream"), true);
    // Must not wash into a generic fabricated receipt identity.
    assert.equal(stderr[0]!.includes("ak_judge_output"), false);

    const bookKey = resolveBookKeyFromGit(project);
    const errorPath = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      "run-unrec-001@judge",
      "artifacts",
      "error.json",
    );
    const errorBody = JSON.parse(await readFile(errorPath, "utf8")) as {
      cause: string;
      diagnostic: string;
      identity?: { name?: string };
    };
    assert.equal(errorBody.cause, "unrecognized");
    assert.equal(errorBody.diagnostic, "ECONNRESET from upstream");
    assert.equal(errorBody.identity?.name, "RawSocketError");
  });
});

test("timeout controlled failure settles with typed timeout cause and Error Artifact", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "slow"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-timeout-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: null,
            stdout: "",
            stderr: "still running\n",
            timedOut: true,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.equal(formatFailureStderrDiagnostic({
      cause: "timeout",
      diagnostic: "judge role run timed out",
    }).includes("\n"), true);

    const bookKey = resolveBookKeyFromGit(project);
    const errorBody = JSON.parse(
      await readFile(
        join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          "run-timeout-001@judge",
          "artifacts",
          "error.json",
        ),
        "utf8",
      ),
    ) as { cause: string };
    assert.equal(errorBody.cause, "timeout");
  });
});

test("empty object, bogus status, and incomplete continue are not lawful outcomes", () => {
  const cases: unknown[] = [
    {},
    { judgeStatus: "bogus" },
    { judgeStatus: "continue" },
    { judgeStatus: "continue", fix: { summary: "x" }, classes: [] },
    { judgeStatus: "accepted" },
  ];
  for (const details of cases) {
    const outcome = extractJudgeRoleOutcome([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          isError: false,
          details,
        },
      },
    ]);
    assert.equal(
      outcome,
      undefined,
      `expected non-lawful details to be rejected: ${JSON.stringify(details)}`,
    );
  }
});

test("each controlled cause persists typed Error Artifact without manufacturing a Receipt", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const causes: ControlledFailureCause[] = [
      "activation",
      "provider",
      "session",
      "output",
      "timeout",
      "unrecognized",
    ];
    for (const cause of causes) {
      const runId = `run-cause-${cause}`;
      const runDirectory = join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        `${runId}@judge`,
      );
      await mkdir(join(runDirectory, "session"), { recursive: true });
      const admitted = {
        role: "judge" as const,
        runId,
        bookKey,
        projectRoot: project,
        instruction: "x",
        instructionEmpty: false,
        attachments: [],
        runDirectory,
        sessionDirectory: join(runDirectory, "session"),
        admittedRequestPath: join(runDirectory, "admitted-request.json"),
      };
      await writeFile(admitted.admittedRequestPath, "{}\n", "utf8");
      const terminal = await settleJudgeFailureTerminalResult(admitted, {
        cause,
        diagnostic: `diagnostic for ${cause}`,
        identity: { name: "CauseProbeError", code: cause },
      });
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind !== "failure") throw new Error("expected failure");
      assert.equal(terminal.roleOutcome.cause, cause);
      assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
      assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);
      const errorRef = terminal.artifacts.find((a) => a.kind === "error");
      assert.ok(errorRef);
      const body = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
        kind: string;
        cause: string;
        diagnostic: string;
        identity?: { name?: string; code?: string };
      };
      assert.equal(body.kind, "error");
      assert.equal(body.cause, cause);
      assert.equal(body.diagnostic, `diagnostic for ${cause}`);
      assert.equal(body.identity?.name, "CauseProbeError");
      // Must not look like a manufactured Judge Receipt status.
      assert.equal("judgeStatus" in body, false);
    }
  });
});

test("zero-exit missing session classifies as session cause via public entry", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "no session bytes"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-session-missing-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          // Admitted session directory exists but holds no transcript.
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    const bookKey = resolveBookKeyFromGit(project);
    const errorBody = JSON.parse(
      await readFile(
        join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          "run-session-missing-001@judge",
          "artifacts",
          "error.json",
        ),
        "utf8",
      ),
    ) as { cause: string };
    assert.equal(errorBody.cause, "session");
  });
});

test("zero-exit invalid judge details classifies as output cause via public entry", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "bogus details"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-output-bogus-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { judgeStatus: "bogus" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    const bookKey = resolveBookKeyFromGit(project);
    const errorBody = JSON.parse(
      await readFile(
        join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          "run-output-bogus-001@judge",
          "artifacts",
          "error.json",
        ),
        "utf8",
      ),
    ) as { cause: string };
    assert.equal(errorBody.cause, "output");
  });
});

test("provider-tagged thrown failure keeps provider cause and identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "provider down"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-provider-001",
        io,
        piRunner: async () => {
          const err = new Error("model upstream 503");
          err.name = "ProviderUnavailableError";
          (err as { failureCause?: string }).failureCause = "provider";
          (err as { code?: string }).code = "PROVIDER_UNAVAILABLE";
          throw err;
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.equal(stderr[0]!.includes("model upstream 503"), true);
    const bookKey = resolveBookKeyFromGit(project);
    const errorBody = JSON.parse(
      await readFile(
        join(
          home,
          ".ak-roles",
          "books",
          bookKey,
          "runs",
          "run-provider-001@judge",
          "artifacts",
          "error.json",
        ),
        "utf8",
      ),
    ) as {
      cause: string;
      diagnostic: string;
      identity?: { name?: string; code?: string };
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.diagnostic, "model upstream 503");
    assert.equal(errorBody.identity?.name, "ProviderUnavailableError");
    assert.equal(errorBody.identity?.code, "PROVIDER_UNAVAILABLE");
  });
});

test("lawful terminal preferred over child nonzero exit (no wash into failure)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "already settled"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-prefer-lawful-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { judgeStatus: "converged" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 1,
            stdout: "",
            stderr: "late host noise\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 0);

    const bookKey = resolveBookKeyFromGit(project);
    const terminal = await settleJudgeTerminalResult({
      role: "judge",
      runId: "run-prefer-lawful-001",
      runDirectory: join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-prefer-lawful-001@judge",
      ),
      sessionDirectory: join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-prefer-lawful-001@judge",
        "session",
      ),
      projectRoot: project,
      bookKey,
      instruction: "already settled",
      instructionEmpty: false,
      attachments: [],
      admittedRequestPath: join(
        home,
        ".ak-roles",
        "books",
        bookKey,
        "runs",
        "run-prefer-lawful-001@judge",
        "admitted-request.json",
      ),
    });
    assert.equal(terminal.roleOutcome.kind, "accepted");
    if (terminal.roleOutcome.kind !== "accepted") throw new Error("expected accepted");
    assert.equal(terminal.roleOutcome.status, "converged");
  });
});
