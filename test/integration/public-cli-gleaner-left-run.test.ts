import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #502 public Gleaner-Left seat — required --base, empty instruction admitted,
 * #599 resume continues the exact session; empty/nonempty 弹章 → typed Terminal.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "../../src/gleaner-left-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  admitGleanerLeftInvocation,
  parseGleanerLeftArgv,
} from "../../src/public-cli/invocation.ts";
import { buildGleanerLeftTurnRequest } from "../../src/public-cli/gleaner-left-run.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-gleaner-left-", scenario);
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "gleaner-left@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Gleaner Left Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
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

function scriptedGleanerLeftSession(details: unknown) {
  return scriptedTerminatingToolSession({
    role: "gleaner-left",
    toolName: GLEANER_LEFT_OUTPUT_TOOL_NAME,
    details,
  });
}

test("gleaner-left requires --base and admits empty instruction", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    assert.throws(() => parseGleanerLeftArgv([]), (error: unknown) => {
      return error instanceof CliUsageError;
    });
    assert.throws(() => parseGleanerLeftArgv(["--bogus"]), (error: unknown) => {
      return error instanceof CliUsageError;
    });

    const parsed = parseGleanerLeftArgv(["--project", project, "--base", "HEAD"]);
    assert.equal(parsed.instruction, "");
    assert.equal(parsed.baseRevision, "HEAD");

    const admitted = await admitGleanerLeftInvocation({
      home,
      principalAuthority: piDurablePrincipalAuthority,
      cwd: project,
      instruction: "",
      baseRevision: parsed.baseRevision,
      createRunId: () => "01a0glean00-0000-7000-8000-000000000001",
    });

    assert.equal(admitted.role, "gleaner-left");
    assert.equal(admitted.instructionEmpty, true);
    assert.equal(admitted.baseRevision, "HEAD");
    assert.equal(admitted.attachments.length, 0);
    assert.equal(admitted.ticketNumber, undefined);

    const turn = buildGleanerLeftTurnRequest(admitted, {
      packageRoot,
      home,
      agentDir: join(home, ".pi"),
      continuation: { kind: "initial", prompt: "" },
    });
    assert.equal(turn.activation.role, "gleaner-left");
    assert.ok(turn.activation.role === "gleaner-left");
    assert.equal(turn.activation.baseRevision, "HEAD");
  });
});

test("public gleaner-left settles empty 弹章 as typed Terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-000000000010";
    const receipt = { status: "completed" as const, findings: [] as const };
    const { io } = captureIo();
    const result = await runAkRole(
      ["gleaner-left", "--project", project, "--base", "HEAD"],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedGleanerLeftSession(receipt),
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.equal(result.terminal.roleOutcome.role, "gleaner-left");
    assert.equal(result.terminal.roleOutcome.status, "completed");
    const facts = result.terminal.roleOutcome.decisiveFacts as Record<string, unknown>;
    assert.equal(facts.status, "completed");
    assert.deepEqual(facts.findings, []);

    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "gleaner-left",
      home,
    });
    const state = await readRoleRunState(
      coords.runDirectory,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.role, "gleaner-left");
    assert.equal(state?.state, "terminal");
  });
});

test("public gleaner-left settles nonempty 弹章 pointer/statement as typed Terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-000000000020";
    const receipt = {
      status: "completed" as const,
      findings: [
        {
          pointer: "src/packaged-role-registry.ts:22",
          statement: "公开角色表未收编左拾遗",
        },
      ],
    };
    const { io } = captureIo();
    const result = await runAkRole(
      ["gleaner-left", "--project", project, "--base", "HEAD"],
      {
        home,
        packageRoot,
        cwd: project,
        io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedGleanerLeftSession(receipt),
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.equal(result.terminal.roleOutcome.status, "completed");
    const facts = result.terminal.roleOutcome.decisiveFacts as Record<string, unknown>;
    const findings = facts.findings as readonly {
      pointer: string;
      statement: string;
    }[];
    assert.equal(findings[0]?.pointer, "src/packaged-role-registry.ts:22");
    assert.equal(findings[0]?.statement, "公开角色表未收编左拾遗");
  });
});

test("ak-role resume continues gleaner-left on the exact session and base", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-0000000000aa";
    // Ticket acceptance surface: interrupt first (unsealed), then resume lands a
    // distinct sealed 弹章 — not a vacuous re-read of a first-run seal (#599).
    const first = await runAkRole(
      ["gleaner-left", "--project", project, "--base", "HEAD"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await mkdir(join(sessionFile, ".."), { recursive: true });
            await writeFile(sessionFile, "\n", "utf8");
            return {
              code: 1,
              stderr: "upstream timeout\n",
              timedOut: true,
              args: [...args],
            };
          },
        }),
      },
    );
    assert.equal(first.exitCode, 1);
    assert.equal(first.terminal?.roleOutcome.kind, "failure");
    assert.equal(
      first.terminal?.roleOutcome.kind === "failure"
        ? first.terminal.roleOutcome.cause
        : undefined,
      "timeout",
    );

    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId,
      role: "gleaner-left",
      home,
    });
    const { io, stdout } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          resumeArgs = [...args];
          return scriptedGleanerLeftSession({
            status: "completed",
            findings: [
              {
                pointer: "src/packaged-role-registry.ts:146",
                statement: "RESUMED-弹章",
              },
            ],
          })(args, options);
        },
      }),
    });
    assert.equal(resumed.exitCode, 0, stdout.join("") || "gleaner-left resume failed");
    assert.equal(Array.isArray(resumeArgs), true);
    assert.equal(resumeArgs![resumeArgs!.indexOf("--ak-role") + 1], "gleaner-left");
    assert.equal(resumeArgs![resumeArgs!.indexOf("--session-dir") + 1], coords.sessionDirectory);
    assert.equal(resumed.terminal?.roleOutcome.role, "gleaner-left");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "completed",
    );
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? (resumed.terminal.roleOutcome.decisiveFacts as Record<string, unknown>)
      : undefined;
    const findings = facts?.findings as readonly { pointer?: string; statement?: string }[] | undefined;
    assert.equal(findings?.[0]?.statement, "RESUMED-弹章");
  });
});

test("ak-role resume after sealed gleaner-left presents the sealed 弹章 without dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-0000000000ab";
    const first = await runAkRole(
      ["gleaner-left", "--project", project, "--base", "HEAD"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedGleanerLeftSession({
            status: "completed",
            findings: [
              {
                pointer: "src/packaged-role-registry.ts:22",
                statement: "FIRST-弹章",
              },
            ],
          }),
        }),
      },
    );
    assert.equal(first.exitCode, 0);
    assert.equal(first.terminal?.roleOutcome.kind, "accepted");

    let resumeDispatches = 0;
    const { io, stdout } = captureIo();
    const resumed = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          resumeDispatches += 1;
          return scriptedGleanerLeftSession({
            status: "completed",
            findings: [
              {
                pointer: "src/packaged-role-registry.ts:146",
                statement: "RESUMED-must-not-land",
              },
            ],
          })(args, options);
        },
      }),
    });
    assert.equal(resumeDispatches, 0, "sealed resume must not dispatch a doomed turn");
    assert.equal(resumed.exitCode, 0, stdout.join("") || "sealed gleaner-left resume failed");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    const facts = resumed.terminal?.roleOutcome.kind === "accepted"
      ? (resumed.terminal.roleOutcome.decisiveFacts as Record<string, unknown>)
      : undefined;
    const findings = facts?.findings as readonly { statement?: string }[] | undefined;
    assert.equal(findings?.[0]?.statement, "FIRST-弹章");
  });
});

test("gleaner-left resume timeout is not masked by a prior-attempt residual", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const runId = "01a0glean00-0000-7000-8000-0000000000ac";
    const first = await runAkRole(
      ["gleaner-left", "--project", project, "--base", "HEAD"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => runId,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: scriptedTerminatingToolSession({
            role: "gleaner-left",
            toolName: GLEANER_LEFT_OUTPUT_TOOL_NAME,
            details: { status: "completed", findings: [] },
            isError: true,
            acceptedText: "PRIOR-attempt-residual-error",
          }),
        }),
      },
    );
    assert.equal(first.exitCode, 1);
    assert.equal(
      first.terminal?.roleOutcome.kind === "failure"
        ? first.terminal.roleOutcome.cause
        : undefined,
      "output",
    );

    const { io, stdout } = captureIo();
    const resumed = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          const prior = await readFile(sessionFile, "utf8");
          const resumeUser = {
            type: "message",
            id: "user-resume",
            parentId: null,
            timestamp: "2026-08-30T00:01:00.000Z",
            message: { role: "user", content: "resume", timestamp: 10 },
          };
          await writeFile(
            sessionFile,
            `${prior}${JSON.stringify(resumeUser)}\n`,
            "utf8",
          );
          return {
            code: 1,
            stderr: "upstream timeout\n",
            timedOut: true,
            args: [...args],
          };
        },
      }),
    });
    assert.equal(resumed.exitCode, 1, stdout.join("") || "resume timeout path failed");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "failure"
        ? resumed.terminal.roleOutcome.cause
        : undefined,
      "timeout",
      "prior-attempt residual must not mask current resume timeout",
    );
  });
});
