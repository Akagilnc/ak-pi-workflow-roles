/**
 * #107 failure + human-decision settlement seam.
 * Seams: parseJudgeArgv / admitJudgeInvocation / settleJudge* /
 * runAkRole(judge) with injectable Pi runner / TerminalResult typed owners.
 * Assert typed regions, emission count, durability, exit — never table labels/layout.
 */
import assert from "node:assert/strict";
import {
  access,
  chmod,
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
  ExplicitInternalActivationError,
  knownFailureFromProviderStop,
} from "../../src/public-cli/explicit-internal.ts";
import {
  classifyPostAdmissionFailure,
  CONCISE_DIAGNOSTIC_MAX_CHARS,
  exitCodeForTerminalOutcome,
  extractJudgeRoleOutcome,
  extractSessionProviderStop,
  formatFailureStderrDiagnostic,
  isChildDiagnosticFloodLine,
  isChildDiagnosticHelpFooterLine,
  isLawfulTypedTerminalOutcome,
  settleJudgeFailureTerminalResult,
} from "../../src/public-cli/settlement.ts";
import type {
  ControlledFailureCause,
  TerminalArtifactRef,
  TerminalResult,
} from "../../src/public-cli/terminal.ts";
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

/** Realistic observation face: Error then JSONL tool_execution_end (repo observation shape). */
function realisticJsonlFloodStderr(): string {
  return [
    "Error: provider rejected the request",
    JSON.stringify({
      event: "tool_execution_end",
      role: "judge",
      toolCallId: "t1",
      toolName: "bash",
      timestamp: "2026-01-01T00:00:00.000Z",
      isError: false,
    }),
  ].join("\n");
}

function oversizedDiagnosticStderr(): string {
  return `Error: ${"x".repeat(CONCISE_DIAGNOSTIC_MAX_CHARS + 200)}\n`;
}

/** Assert public-seam failure Terminal typed regions + emission counts. */
async function assertPublicFailureSettlement(input: {
  result: { exitCode: number; terminal?: TerminalResult };
  stdout: string[];
  stderr: string[];
  expectedCause: ControlledFailureCause;
  diagnosticIncludes?: string;
  diagnosticEquals?: string;
  identityName?: string;
  identityCode?: string | number;
}): Promise<{ terminal: TerminalResult; errorRef: TerminalArtifactRef }> {
  assert.equal(input.result.exitCode, 1);
  assert.equal(input.stdout.length, 1, "exactly one stdout Terminal emission");
  assert.equal(input.stderr.length, 1, "exactly one stderr diagnostic emission");
  assert.ok((input.stdout[0] ?? "").length > 0);
  assert.equal(
    input.stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
    1,
    "stderr diagnostic must be one concise line",
  );

  const terminal = input.result.terminal;
  assert.ok(terminal, "public seam must return settled Terminal");
  assert.equal(terminal.roleOutcome.kind, "failure");
  if (terminal.roleOutcome.kind !== "failure") {
    throw new Error("expected failure role outcome");
  }
  assert.equal(terminal.roleOutcome.cause, input.expectedCause);
  assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
  assert.ok(terminal.roleOutcome.diagnostic.length > 0);
  if (input.diagnosticEquals !== undefined) {
    assert.equal(terminal.roleOutcome.diagnostic, input.diagnosticEquals);
  }
  if (input.diagnosticIncludes !== undefined) {
    assert.equal(
      terminal.roleOutcome.diagnostic.includes(input.diagnosticIncludes),
      true,
    );
  }
  assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
  assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);
  assert.ok(terminal.navigator);
  assert.equal(terminal.resume, undefined);
  assert.equal(typeof terminal.runId, "string");
  assert.ok(terminal.runId !== undefined && terminal.runId.length > 0);
  assert.ok(Array.isArray(terminal.artifacts));
  assert.ok(terminal.artifacts.length >= 1);

  // Durability via typed artifact refs — never private layout/filenames.
  const errorRef = terminal.artifacts.find((a) => a.kind === "error");
  assert.ok(errorRef, "failure Terminal must carry error artifact ref");
  const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
    kind: string;
    cause: string;
    diagnostic: string;
    identity?: { name?: string; code?: string | number };
  };
  assert.equal(errorBody.kind, "error");
  assert.equal(errorBody.cause, input.expectedCause);
  assert.equal(errorBody.diagnostic, terminal.roleOutcome.diagnostic);
  if (input.identityName !== undefined) {
    assert.equal(errorBody.identity?.name, input.identityName);
  }
  if (input.identityCode !== undefined) {
    assert.equal(errorBody.identity?.code, input.identityCode);
  }
  assert.equal("judgeStatus" in errorBody, false);

  const evidenceRef = terminal.artifacts.find((a) => a.kind === "evidence");
  assert.ok(evidenceRef, "failure Terminal must carry evidence artifact ref");
  await access(evidenceRef!.path);

  // Presentation is bounded even when durable diagnostic is longer.
  const presented = input.stderr[0]!;
  assert.ok(presented.length <= CONCISE_DIAGNOSTIC_MAX_CHARS + 32);

  return { terminal, errorRef: errorRef! };
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
    // Typed admission oracle: structural reject never produces a Terminal.
    assert.equal(result.terminal, undefined);
  });
});

test("empty --project= rejects structurally before admission with no model dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    let dispatched = 0;
    const result = await runAkRole(["judge", "--project=", "task"], {
      packageRoot,
      home,
      cwd: project,
      io,
      piRunner: async (args) => {
        dispatched += 1;
        return {
          code: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    // Empty project must not resolve("") → cwd and complete admission/dispatch.
    assert.equal(result.exitCode, 2);
    assert.equal(dispatched, 0);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.length >= 1, true);
    // Typed admission oracle: structural reject never produces a Terminal.
    assert.equal(result.terminal, undefined);
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
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.runId, "run-domain-001");
    assert.ok(result.terminal!.artifacts.some((a) => a.kind === "report"));
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

  // Production-owned typed thrown channel.
  const typed = classifyPostAdmissionFailure({
    timedOut: false,
    code: null,
    stderr: "",
    thrown: new ExplicitInternalActivationError("model upstream 503", {
      knownCause: "provider",
      name: "ProviderUnavailableError",
      code: "PROVIDER_UNAVAILABLE",
    }),
  });
  assert.equal(typed.cause, "provider");
  assert.equal(typed.diagnostic, "model upstream 503");
  assert.equal(typed.identity?.name, "ProviderUnavailableError");
  assert.equal(typed.identity?.code, "PROVIDER_UNAVAILABLE");

  // JSONL observation flood must not displace the real diagnostic.
  const jsonl = classifyPostAdmissionFailure({
    timedOut: false,
    code: 1,
    stderr: realisticJsonlFloodStderr(),
  });
  assert.equal(jsonl.cause, "activation");
  assert.equal(jsonl.diagnostic, "provider rejected the request");
  assert.equal(isChildDiagnosticFloodLine(JSON.stringify({ event: "tool_execution_end" })), true);

  // Pi auth-guidance multi-line stderr: help-footer lines must not wash the primary diagnostic.
  const primaryAuthDiagnostic = "No API key found for the selected model.";
  const authGuidanceStderr = [
    primaryAuthDiagnostic,
    "",
    "Use /login to log into a provider via OAuth or API key. See:",
    "  /tmp/example-docs/alpha.md",
    "  /tmp/example-docs/beta.md",
  ].join("\n");
  assert.equal(isChildDiagnosticHelpFooterLine("/tmp/example-docs/alpha.md"), true);
  assert.equal(
    isChildDiagnosticHelpFooterLine(
      "Use /login to log into a provider via OAuth or API key. See:",
    ),
    true,
  );
  const authGuidance = classifyPostAdmissionFailure({
    timedOut: false,
    code: 1,
    stderr: authGuidanceStderr,
    knownCause: "provider",
    knownIdentity: {
      name: "MissingProviderCredential",
      code: "xai",
    },
  });
  assert.equal(authGuidance.cause, "provider");
  // Typed sentinel round-trip: primary diagnostic retained, not a footer line.
  assert.equal(authGuidance.diagnostic, primaryAuthDiagnostic);
  assert.equal(authGuidance.identity?.name, "MissingProviderCredential");
  assert.equal(authGuidance.identity?.code, "xai");

  // AC2: timedOut must not wash a co-present typed knownCause identity/diagnostic.
  const timedOutWithProvider = classifyPostAdmissionFailure({
    timedOut: true,
    code: null,
    stderr: floodStderr(),
    knownCause: "provider",
    knownIdentity: { name: "ProviderStopError", code: "openai-codex" },
    knownDiagnostic: "rate limited",
  });
  assert.equal(timedOutWithProvider.cause, "provider");
  assert.equal(timedOutWithProvider.diagnostic, "rate limited");
  assert.equal(timedOutWithProvider.identity?.name, "ProviderStopError");
  assert.equal(timedOutWithProvider.identity?.code, "openai-codex");
  assert.equal(timedOutWithProvider.details?.timedOut, true);

  // AC5: `throw undefined` is a present exception — not missing thrown / activation / output.
  const thrownUndefined = classifyPostAdmissionFailure({
    timedOut: false,
    code: null,
    stderr: "",
    thrown: undefined,
  });
  assert.equal(thrownUndefined.cause, "unrecognized");
  assert.equal(thrownUndefined.diagnostic, "undefined");
  // Absence of the thrown key still means no exception was observed.
  const noThrownKey = classifyPostAdmissionFailure({
    timedOut: false,
    code: null,
    stderr: "",
  });
  assert.equal(noThrownKey.cause, "activation");
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
      sessionFile: join(runDirectory, "session", "session.jsonl"),
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
    // Typed sentinel round-trip of the injected diagnostic (not presentation prose).
    assert.equal(terminal.roleOutcome.diagnostic, "provider rejected credentials");
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
    // No session attendance → typed unavailable, never inferred no-advice.
    assert.equal(terminal.navigator.disposition, "unavailable");
    if (terminal.navigator.disposition === "unavailable") {
      assert.equal(terminal.navigator.source, "unknown");
      assert.equal(typeof terminal.navigator.reason, "string");
    }
  });
});

test("failure settlement Terminal agrees with exact-session affirmative attendance", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const runId = "run-fail-attendance-001";
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, "session.jsonl");
    const attendanceDetails = {
      version: 1,
      disposition: "no-advice",
      invocationId: "019f8c2a-6666-7666-8666-666666666666",
      role: "judge",
      phase: null,
      subjectKey: `${project}/.ak/work`,
    };
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: "ak-navigator-invocation",
          data: {
            invocationId: "019f8c2a-6666-7666-8666-666666666666",
            role: "judge",
            phase: null,
            subjectKey: attendanceDetails.subjectKey,
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolName: JUDGE_OUTPUT_TOOL_NAME,
            toolCallId: "fatal-judge",
            // Durable accepted terminal for attendance correlation; retryable
            // isError:true/details:{} is nonterminal under the shared classifier.
            isError: false,
            details: { judgeStatus: "converged" },
          },
        }),
        JSON.stringify({
          type: "custom_message",
          customType: "ak-navigator-attendance",
          message: { details: attendanceDetails },
          details: attendanceDetails,
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const admitted = {
      role: "judge" as const,
      runId,
      bookKey,
      projectRoot: project,
      instruction: "x",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      sessionDirectory,
      sessionFile,
      admittedRequestPath: join(runDirectory, "admitted-request.json"),
    };
    await writeFile(admitted.admittedRequestPath, "{}\n", "utf8");

    const terminal = await settleJudgeFailureTerminalResult(admitted, {
      cause: "activation",
      diagnostic: "role infrastructure failed",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
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

    const { terminal } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "activation",
      diagnosticEquals: "provider boom",
    });
    // stderr: emission shape + non-flood only (AC6) — not selected presentation prose.
    assert.equal(stderr[0]!.includes("at Object.fn"), false);
    assert.equal(stderr[0]!.includes("event:"), false);
    assert.equal(stderr[0]!.includes("tokens="), false);
    assert.equal(
      stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
      1,
    );
    assert.equal(terminal.runId, "run-fail-emit-001");
  });
});

test("JSONL tool_execution event flood keeps real diagnostic; oversized line is presentation-bounded", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Counterexample 1: Error then real-shaped JSONL tool_execution_end.
    {
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "jsonl flood"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-jsonl-flood-001",
          io,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stdout: "",
              stderr: realisticJsonlFloodStderr(),
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
      const { terminal } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "activation",
        diagnosticEquals: "provider rejected the request",
      });
      // Durable cause keeps the real diagnostic; presentation must not select the JSON event.
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.diagnostic.includes("tool_execution_end"), false);
      }
      // stderr oracle is emission shape + non-flood — not selected diagnostic prose (AC6).
      assert.equal(stderr[0]!.includes("tool_execution_end"), false);
    }

    // Counterexample 2: single oversized diagnostic line — durable full, presentation bound.
    {
      const full = "x".repeat(CONCISE_DIAGNOSTIC_MAX_CHARS + 200);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--project", project, "oversized diagnostic"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-oversize-diag-001",
          io,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stdout: "",
              stderr: oversizedDiagnosticStderr(),
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
      const { terminal, errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "activation",
        diagnosticEquals: full,
      });
      const body = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        diagnostic: string;
      };
      // Durable evidence keeps the full diagnostic identity.
      assert.equal(body.diagnostic, full);
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.diagnostic, full);
      }
      // Presentation bound is length/count only (AC6) — never ellipsis glyph or truncated prose.
      // Helper already asserts one nonblank stderr line and CONCISE_DIAGNOSTIC_MAX_CHARS + 32.
      assert.ok(stderr[0]!.length < full.length);
    }
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
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "audit_escalation");
    if (result.terminal!.roleOutcome.kind !== "audit_escalation") {
      throw new Error("expected audit_escalation");
    }
    assert.equal(result.terminal!.roleOutcome.status, "audit_escalation");
    assert.equal(isLawfulTypedTerminalOutcome(result.terminal!.roleOutcome), true);
    assert.equal(exitCodeForTerminalOutcome(result.terminal!.roleOutcome), 0);
    assert.equal(
      result.terminal!.roleOutcome.decisiveFacts.kind,
      AUDIT_ESCALATION_KIND,
    );
    assert.equal(result.terminal!.runId, "run-escalation-001");
    assert.ok(result.terminal!.artifacts.some((a) => a.kind === "report"));
    const reportRef = result.terminal!.artifacts.find((a) => a.kind === "report");
    assert.ok(reportRef);
    await access(reportRef!.path);
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
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    if (result.terminal!.roleOutcome.kind !== "accepted") throw new Error("expected accepted");
    assert.equal(result.terminal!.roleOutcome.status, "escalate");
    assert.equal(exitCodeForTerminalOutcome(result.terminal!.roleOutcome), 0);
    assert.equal(result.terminal!.runId, "run-escalate-001");
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

    await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "unrecognized",
      diagnosticEquals: "ECONNRESET from upstream",
      identityName: "RawSocketError",
    });
    // stderr: non-flood shape only — durable identity lives on Terminal/Error Artifact (AC6).
    assert.equal(stderr[0]!.includes("ak_judge_output"), false);
  });
});

test("post-admission throw undefined stays unrecognized (not activation/null-exit)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();

    const result = await runAkRole(
      ["judge", "--project", project, "runner throws undefined"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-throw-undefined-001",
        io,
        piRunner: async () => {
          throw undefined;
        },
      },
    );

    const { terminal } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "unrecognized",
      diagnosticEquals: "undefined",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      // Presence of thrown undefined must not wash into activation or null-exit output.
      assert.equal(terminal.roleOutcome.cause, "unrecognized");
      assert.notEqual(terminal.roleOutcome.cause, "activation");
      assert.notEqual(terminal.roleOutcome.cause, "output");
    }
  });
});

test("artifact publication EISDIR retains unrecognized identity (not washed to output)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "lawful then publish fails"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-eisdir-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          // Converged session is lawful; report.json as a directory makes writeFile EISDIR.
          await mkdir(join(runDir, "artifacts", "report.json"), { recursive: true });
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
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "unrecognized",
      identityCode: "EISDIR",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "unrecognized");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR");
      // Must not wash publication errno into generic output absence.
      assert.notEqual(terminal.roleOutcome.cause, "output");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string; code?: string | number };
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "unrecognized");
    assert.equal(errorBody.identity?.code, "EISDIR");
    assert.equal(typeof errorBody.diagnostic, "string");
    assert.ok(errorBody.diagnostic.length > 0);
    assert.equal(errorBody.diagnostic.toLowerCase().includes("eisdir") || errorBody.identity?.code === "EISDIR", true);
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
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "timeout",
    });
    // Typed timeout identity — not package presentation prose.
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "timeout");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      details?: { timedOut?: boolean };
    };
    assert.equal(errorBody.cause, "timeout");
    assert.equal(errorBody.details?.timedOut, true);
    // One-line stderr emission already asserted by helper; durable diagnostic stays full.
    assert.equal(stderr[0]!.includes("\n"), true);
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
        sessionFile: join(runDirectory, "session", "session.jsonl"),
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
    await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "session",
    });
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
    await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "output",
    });
  });
});

test("production knownFailure channel reaches settlement as provider with typed identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // Resolved runner result — production-owned channel on ExplicitInternalPiResult,
    // not an ad-hoc thrown Error property and not stderr-prose inference.
    const result = await runAkRole(
      ["judge", "--project", project, "provider down"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-provider-channel-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stdout: "",
            // Deliberately misleading prose — cause must come from knownFailure only.
            stderr: "activation wrapper exited nonzero\n",
            timedOut: false,
            args: [...args],
            knownFailure: {
              cause: "provider",
              identity: {
                name: "ProviderUnavailableError",
                code: "PROVIDER_UNAVAILABLE",
              },
            },
          };
        },
      },
    );
    await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      // Diagnostic may come from stderr selection or fallback; identity is typed.
      identityName: "ProviderUnavailableError",
      identityCode: "PROVIDER_UNAVAILABLE",
    });
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(result.terminal!.roleOutcome.cause, "provider");
      assert.equal(
        result.terminal!.roleOutcome.decisiveFacts.errorName,
        "ProviderUnavailableError",
      );
      assert.equal(
        result.terminal!.roleOutcome.decisiveFacts.errorCode,
        "PROVIDER_UNAVAILABLE",
      );
    }
  });
});

test("production ExplicitInternalActivationError throw keeps provider cause and identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "provider throw"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-provider-throw-001",
        io,
        piRunner: async () => {
          throw new ExplicitInternalActivationError("model upstream 503", {
            knownCause: "provider",
            name: "ProviderUnavailableError",
            code: "PROVIDER_UNAVAILABLE",
          });
        },
      },
    );
    await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      diagnosticEquals: "model upstream 503",
      identityName: "ProviderUnavailableError",
      identityCode: "PROVIDER_UNAVAILABLE",
    });
  });
});

test("credential-boundary knownFailure keeps provider cause when runner omits it", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // Real production shape: default runner has no knownFailure field; public CLI
    // owns credential presence and must not wash missing public-provider auth into activation.
    const result = await runAkRole(
      ["--model", "xai/grok-4:off", "judge", "--project", project, "empty auth"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": false, xai: false },
        createRunId: () => "run-credential-boundary-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stdout: "",
            stderr: [
              "No API key found for the selected model.",
              "",
              "Use /login to log into a provider via OAuth or API key. See:",
              "  /tmp/example-docs/alpha.md",
              "  /tmp/example-docs/beta.md",
            ].join("\n"),
            timedOut: false,
            args: [...args],
            // deliberately omit knownFailure — credential channel must supply cause
          };
        },
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      identityName: "MissingProviderCredential",
      identityCode: "xai",
    });
    // Typed credential-boundary identity + emission bounds (AC6).
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "provider");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "MissingProviderCredential");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, "xai");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string; code?: string | number };
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.identity?.name, "MissingProviderCredential");
    assert.equal(errorBody.identity?.code, "xai");
    assert.equal(typeof errorBody.diagnostic, "string");
    assert.ok(errorBody.diagnostic.length > 0);
    assert.equal(
      stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
      1,
    );
    assert.ok(stderr[0]!.length <= CONCISE_DIAGNOSTIC_MAX_CHARS + 32);
  });
});

test("default runner empty-auth retains provider cause, identity, and primary diagnostic", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // No piRunner: production defaultExplicitInternalPiRunner subprocess.
    // Empty auth.json + selected xai is the live counterexample from Judge apply.
    const result = await runAkRole(
      ["--model", "xai/grok-4:off", "judge", "--project", project, "probe empty auth"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": false, xai: false },
        createRunId: () => "run-default-empty-auth-001",
        judgeTimeoutMs: 60_000,
        io,
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      identityName: "MissingProviderCredential",
      identityCode: "xai",
    });
    // Typed credential channel + emission bounds (AC6) — not presentation prose.
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "provider");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "MissingProviderCredential");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, "xai");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string; code?: string | number };
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.identity?.name, "MissingProviderCredential");
    assert.equal(errorBody.identity?.code, "xai");
    assert.equal(
      stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
      1,
    );
    assert.ok(stderr[0]!.length <= CONCISE_DIAGNOSTIC_MAX_CHARS + 32);
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
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    if (result.terminal!.roleOutcome.kind !== "accepted") throw new Error("expected accepted");
    assert.equal(result.terminal!.roleOutcome.status, "converged");
    assert.equal(result.terminal!.runId, "run-prefer-lawful-001");
  });
});

test("Error Artifact primary collision retains original failure cause with Terminal emission", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "activation then error artifact collision"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-error-artifact-collision-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          // Primary Error Artifact path occupied as a directory → writeFile EISDIR.
          // Settlement must fall back durably and keep the original activation cause.
          await mkdir(join(runDir, "artifacts", "error.json"), { recursive: true });
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stdout: "",
            stderr: "Error: original activation boom\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "activation",
      diagnosticEquals: "original activation boom",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      // Original controlled failure must not be washed to the publication errno.
      assert.equal(terminal.roleOutcome.cause, "activation");
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR");
      assert.equal(terminal.roleOutcome.diagnostic, "original activation boom");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      publicationIssues?: Array<{ identity?: { code?: string | number } }>;
    };
    assert.equal(errorBody.cause, "activation");
    assert.equal(errorBody.diagnostic, "original activation boom");
    assert.ok(Array.isArray(errorBody.publicationIssues));
    assert.ok(
      errorBody.publicationIssues!.some((issue) => issue.identity?.code === "EISDIR"),
      "durable fallback must retain the primary publication collision identity",
    );
    // One complete Terminal — must not escape to outer raw catch with zero stdout.
    assert.equal(stdout.length, 1);
    assert.equal(result.terminal !== undefined, true);
  });
});

test("exhausted fixed Error Artifact names still settle original cause via unique fallback", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "exhaust fixed error artifact names"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-error-artifact-exhausted-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          // Occupy every fixed preferred Error Artifact candidate as a directory.
          // Settlement must not escape to outer catch with only the last EISDIR.
          await mkdir(join(runDir, "artifacts", "error.json"), { recursive: true });
          await mkdir(join(runDir, "artifacts", "error.settlement.json"), {
            recursive: true,
          });
          await mkdir(join(runDir, "error.settlement.json"), { recursive: true });
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stdout: "",
            stderr: "Error: original activation boom\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "activation",
      diagnosticEquals: "original activation boom",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "activation");
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR");
      assert.equal(terminal.roleOutcome.diagnostic, "original activation boom");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      publicationIssues?: Array<{ identity?: { code?: string | number } }>;
    };
    assert.equal(errorBody.cause, "activation");
    assert.equal(errorBody.diagnostic, "original activation boom");
    assert.ok(Array.isArray(errorBody.publicationIssues));
    assert.ok(
      errorBody.publicationIssues!.some((issue) => issue.identity?.code === "EISDIR"),
    );
    assert.equal(stdout.length, 1);
    assert.equal(result.terminal !== undefined, true);
  });
});

test("malformed session JSONL settles as typed session failure retaining SyntaxError identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "malformed session transcript"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-malformed-session-jsonl-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          // Invalid JSONL must not wash into cause=output generic absence.
          await writeFile(join(sessionDir, "session.jsonl"), "{not-json\n", "utf8");
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

    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "session",
      identityName: "SyntaxError",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "session");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "SyntaxError");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string };
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "session");
    assert.equal(errorBody.identity?.name, "SyntaxError");
    assert.equal(errorBody.diagnostic, terminal.roleOutcome.diagnostic);
    assert.equal(stdout.length, 1);
    assert.equal(
      stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
      1,
    );
  });
});

test("unwritable run directory retains activation cause with durable Error Artifact and Terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    let runDir: string | undefined;
    try {
      const result = await runAkRole(
        ["judge", "--project", project, "activation boom then unwritable run"],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => "run-unwritable-run-dir-001",
          io,
          piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            runDir = join(sessionDir, "..");
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            // Lock the entire run tree after the child failure is observed.
            // Settlement must escape to the ledger runs/ parent, keep boom primary,
            // and still emit one Terminal — not outer-catch EACCES alone.
            await chmod(runDir, 0o555);
            return {
              code: 1,
              stdout: "",
              stderr: "Error: boom\n",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );

      const { terminal, errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "activation",
        diagnosticEquals: "boom",
      });
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.cause, "activation");
        assert.equal(terminal.roleOutcome.diagnostic, "boom");
        assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EACCES");
      }
      const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        cause: string;
        diagnostic: string;
        publicationIssues?: Array<{ identity?: { code?: string | number } }>;
      };
      assert.equal(errorBody.cause, "activation");
      assert.equal(errorBody.diagnostic, "boom");
      assert.ok(Array.isArray(errorBody.publicationIssues));
      assert.ok(
        errorBody.publicationIssues!.some(
          (issue) => issue.identity?.code === "EACCES",
        ),
        "publication trouble must remain secondary on the durable Error Artifact",
      );
      assert.equal(stdout.length, 1);
      assert.equal(result.terminal !== undefined, true);
    } finally {
      if (runDir !== undefined) {
        try {
          await chmod(runDir, 0o755);
        } catch {
          // cleanup best-effort
        }
      }
    }
  });
});

test("post-admission stderr.log EISDIR keeps child primary and still settles Terminal + Error Artifact", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "stderr log blocked"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-stderr-log-eisdir-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          // stderr.log as a directory makes the post-admission writeFile raise EISDIR.
          // Mirror IO is best-effort — must not wash the already-observed child cause.
          await mkdir(join(runDir, "stderr.log"), { recursive: true });
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stdout: "",
            stderr: "Error: child failed after admission\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "activation",
      diagnosticEquals: "child failed after admission",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "activation");
      assert.equal(terminal.roleOutcome.diagnostic, "child failed after admission");
      // Auxiliary stderr.log errno must not become the primary identity.
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorCode, "EISDIR");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "activation");
    assert.equal(errorBody.diagnostic, "child failed after admission");
    // Must not bypass to outer raw catch (no Terminal / no Error Artifact).
    assert.equal(stdout.length, 1);
    assert.equal(result.terminal !== undefined, true);
  });
});

test("multiline thrown diagnostic keeps full artifact identity and one stderr line", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const multiline = [
      "provider boom with details",
      "    at Object.fn (vendor/stack.js:1:1)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "event: tool_call continuation",
      "tokens=999 tool_calls=3",
    ].join("\n");
    const result = await runAkRole(
      ["judge", "--project", project, "multiline throw"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-multiline-throw-001",
        io,
        piRunner: async () => {
          const error = new Error(multiline);
          error.name = "UpstreamProviderError";
          throw error;
        },
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "unrecognized",
      diagnosticEquals: multiline,
      identityName: "UpstreamProviderError",
    });
    // Durable Terminal/Artifact keep the full original diagnostic (newlines intact).
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.diagnostic, multiline);
      assert.equal(terminal.roleOutcome.diagnostic.includes("\n"), true);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      diagnostic: string;
    };
    assert.equal(errorBody.diagnostic, multiline);
    // stderr presentation is exactly one nonblank line, no stack/event/token flood.
    // Do not assert selected diagnostic prose on stderr (AC6) — durable identity is above.
    const presented = stderr[0]!;
    assert.equal(presented.split("\n").filter((line) => line.trim() !== "").length, 1);
    assert.equal(presented.includes("at Object.fn"), false);
    assert.equal(presented.includes("event:"), false);
    assert.equal(presented.includes("tokens="), false);
    // Helper contract: presentation collapses multiline thrown diagnostics.
    const helper = formatFailureStderrDiagnostic({
      cause: "unrecognized",
      diagnostic: multiline,
    });
    assert.equal(helper.split("\n").filter((line) => line.trim() !== "").length, 1);
    assert.equal(helper.includes("at Object.fn"), false);
  });
});

test("session provider-stop produces provider cause without injected knownFailure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // Real production shape: default runner never sets knownFailure; Pi leaves a
    // native assistant stopReason=error in the session (print-mode provider path).
    // Credentials are present so the credential channel cannot supply the cause.
    const result = await runAkRole(
      ["--model", "xai/grok-4:off", "judge", "--project", project, "session provider stop"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-session-provider-stop-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "go" }],
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "WebSocket error",
                  provider: "xai",
                  model: "grok-4",
                  api: "openai-responses",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          return {
            code: 1,
            stdout: "",
            // Deliberately misleading prose — cause must come from session stop, not stderr.
            stderr: "activation wrapper exited nonzero\n",
            timedOut: false,
            args: [...args],
            // deliberately omit knownFailure
          };
        },
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      diagnosticEquals: "WebSocket error",
      identityName: "ProviderStopError",
      identityCode: "xai",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "provider");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "ProviderStopError");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, "xai");
      assert.equal(terminal.roleOutcome.diagnostic, "WebSocket error");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      identity?: { name?: string; code?: string | number };
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.diagnostic, "WebSocket error");
    assert.equal(errorBody.identity?.name, "ProviderStopError");
    assert.equal(errorBody.identity?.code, "xai");
    // Typed seam unit: stopReason error → knownFailure provider; other stops ignored.
    const fromStop = knownFailureFromProviderStop({
      stopReason: "error",
      errorMessage: "WebSocket error",
      provider: "xai",
    });
    assert.equal(fromStop?.cause, "provider");
    assert.equal(fromStop?.identity?.name, "ProviderStopError");
    assert.equal(fromStop?.diagnostic, "WebSocket error");
    assert.equal(
      knownFailureFromProviderStop({ stopReason: "end_turn", errorMessage: "ok" }),
      undefined,
    );
    assert.deepEqual(
      extractSessionProviderStop([
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "WebSocket error",
            provider: "xai",
          },
        },
      ]),
      {
        stopReason: "error",
        errorMessage: "WebSocket error",
        provider: "xai",
      },
    );
    // AC5: later non-error assistant stop closes the trajectory — do not reach
    // back past it to an older provider error (would wash final no-lawful-output).
    assert.equal(
      extractSessionProviderStop([
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "older provider boom",
            provider: "openai-codex",
          },
        },
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "retry" }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "end_turn",
            content: [{ type: "text", text: "could not finish" }],
            provider: "openai-codex",
          },
        },
      ]),
      undefined,
    );
    // Latest assistant error still counts even with earlier non-error turns.
    assert.deepEqual(
      extractSessionProviderStop([
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "end_turn",
            provider: "xai",
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "final provider boom",
            provider: "xai",
          },
        },
      ]),
      {
        stopReason: "error",
        errorMessage: "final provider boom",
        provider: "xai",
      },
    );
  });
});

test("zero-exit session provider-stop retains provider cause (not washed to output)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // Counterexample class: Pi leaves typed stopReason=error but runner code=0.
    // No-lawful path must still read session provider-stop — exit code must not
    // gate the typed cause channel into generic output.
    const result = await runAkRole(
      [
        "--model",
        "xai/grok-4:off",
        "judge",
        "--project",
        project,
        "zero-exit session provider stop",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-zero-exit-session-provider-stop-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "go" }],
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "upstream websocket failed",
                  provider: "xai",
                  model: "grok-4",
                  api: "openai-responses",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          return {
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            args: [...args],
            // deliberately omit knownFailure — production default runner path
          };
        },
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      diagnosticEquals: "upstream websocket failed",
      identityName: "ProviderStopError",
      identityCode: "xai",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "provider");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "ProviderStopError");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, "xai");
      assert.equal(terminal.roleOutcome.diagnostic, "upstream websocket failed");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      identity?: { name?: string; code?: string | number };
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.diagnostic, "upstream websocket failed");
    assert.equal(errorBody.identity?.name, "ProviderStopError");
    assert.equal(errorBody.identity?.code, "xai");
    assert.equal(stdout.length, 1);
    assert.equal(
      stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
      1,
    );
  });
});

test("timedOut with session provider-stop retains provider identity (AC2)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "xai/grok-4:off",
        "judge",
        "--project",
        project,
        "timeout co-present with provider stop",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-timeout-provider-stop-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "provider hung then killed",
                  provider: "xai",
                  model: "grok-4",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
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
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      diagnosticEquals: "provider hung then killed",
      identityName: "ProviderStopError",
      identityCode: "xai",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "provider");
      assert.equal(terminal.roleOutcome.diagnostic, "provider hung then killed");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorName, "ProviderStopError");
      assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, "xai");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      identity?: { name?: string; code?: string | number };
      details?: { timedOut?: boolean };
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.diagnostic, "provider hung then killed");
    assert.equal(errorBody.identity?.name, "ProviderStopError");
    assert.equal(errorBody.identity?.code, "xai");
    assert.equal(errorBody.details?.timedOut, true);
  });
});

test("older provider error then later end_turn settles as output not provider (AC5)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "xai/grok-4:off",
        "judge",
        "--project",
        project,
        "recovered after provider error without lawful output",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-stale-provider-error-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "older provider boom",
                  provider: "xai",
                  model: "grok-4",
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "retry" }],
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "end_turn",
                  content: [{ type: "text", text: "could not call the tool" }],
                  provider: "xai",
                  model: "grok-4",
                },
              }),
            ].join("\n") + "\n",
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
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "output",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "output");
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorName, "ProviderStopError");
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string };
    };
    assert.equal(errorBody.cause, "output");
    assert.notEqual(errorBody.identity?.name, "ProviderStopError");
  });
});
