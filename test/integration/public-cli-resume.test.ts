/**
 * #108 typed HTTP 429 resume seam.
 * Seams: run-lifecycle / settleJudgeFailureTerminalResult / runAkRole(judge|resume)
 * with injectable Pi runner. Assert typed regions, resume command identity,
 * exact-session reopen, temporary overrides, reject-without-replay, one-writer
 * lease — never table labels/layout/prose classification.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  acquireRunWriterLease,
  isV1ResumableFailure,
  loadResumableJudgeRun,
  markRunAdmitted,
  markRunResumable,
  markRunTerminal,
  readRoleRunState,
  readTypedHttp429Observation,
  recordTypedProviderHttpStatus,
  renderResumeCommand,
  RESUME_TRANSPORT_ENVELOPE,
  RunWriterLeaseHeldError,
} from "../../src/public-cli/run-lifecycle.ts";
import { settleJudgeFailureTerminalResult } from "../../src/public-cli/settlement.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

/** Typed-region proof: run ID appears only inside resume.command. */
function assertRunIdOnlyInResumeCommand(
  terminal: TerminalResult,
  runId: string,
): void {
  assert.ok(terminal.resume, "resumable failure must carry typed resume region");
  assert.equal(terminal.resume.command, renderResumeCommand(runId));
  assert.equal(terminal.resume.command.includes(runId), true);
  assert.equal(
    terminal.runId,
    undefined,
    "top-level runId must be omitted on resumable failure Terminal",
  );
  const outsideResumeCommand = {
    roleOutcome: terminal.roleOutcome,
    navigator: terminal.navigator,
    artifacts: terminal.artifacts,
    runId: terminal.runId,
    resumeKeys: terminal.resume === undefined ? [] : Object.keys(terminal.resume),
  };
  assert.equal(
    JSON.stringify(outsideResumeCommand).includes(runId),
    false,
    "run ID must not appear outside resume.command in typed Terminal regions",
  );
}

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-resume-"));
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
  execFileSync("git", ["config", "user.email", "resume@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Resume Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function writeSessionProviderStop(
  sessionDir: string,
  input: {
    provider: string;
    errorMessage: string;
  },
): Promise<void> {
  return writeFile(
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
          errorMessage: input.errorMessage,
          provider: input.provider,
          model: "probe",
          api: "openai-responses",
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}

test("typed HTTP 429 observation is field-based; quota-like prose alone is never enough", async () => {
  await withTempHome(async (home) => {
    const runDir = join(home, "run-obs");
    await mkdir(runDir, { recursive: true });

    // Prose-only file is not a typed observation channel.
    await writeFile(
      join(runDir, "noise.txt"),
      "rate limited quota exhausted HTTP 429 billing\n",
      "utf8",
    );
    assert.equal(await readTypedHttp429Observation(runDir), undefined);

    // Wrong status ignored.
    await recordTypedProviderHttpStatus(runDir, {
      httpStatus: 503,
      provider: "openai-codex",
    });
    assert.equal(await readTypedHttp429Observation(runDir), undefined);

    // Non-v1 provider ignored even at 429.
    await recordTypedProviderHttpStatus(runDir, {
      httpStatus: 429,
      provider: "anthropic",
    });
    assert.equal(await readTypedHttp429Observation(runDir), undefined);

    // Typed Codex/xAI 429 retained.
    await recordTypedProviderHttpStatus(runDir, {
      httpStatus: 429,
      provider: "openai-codex",
    });
    assert.deepEqual(await readTypedHttp429Observation(runDir), {
      httpStatus: 429,
      provider: "openai-codex",
    });

    // Latest non-qualifying response is authoritative: earlier 429 must not stick.
    await recordTypedProviderHttpStatus(runDir, {
      httpStatus: 503,
      provider: "openai-codex",
    });
    assert.equal(await readTypedHttp429Observation(runDir), undefined);

    // A later qualifying 429 may re-arm within the same attempt.
    await recordTypedProviderHttpStatus(runDir, {
      httpStatus: 429,
      provider: "xai",
    });
    assert.deepEqual(await readTypedHttp429Observation(runDir), {
      httpStatus: 429,
      provider: "xai",
    });

    // Non-v1 provider at 429 also supersedes a prior qualifying observation.
    await recordTypedProviderHttpStatus(runDir, {
      httpStatus: 429,
      provider: "anthropic",
    });
    assert.equal(await readTypedHttp429Observation(runDir), undefined);

    assert.equal(
      isV1ResumableFailure({
        hasLawfulTerminalResult: false,
        typedHttp429: { httpStatus: 429, provider: "xai" },
      }),
      true,
    );
    assert.equal(
      isV1ResumableFailure({
        hasLawfulTerminalResult: true,
        typedHttp429: { httpStatus: 429, provider: "xai" },
      }),
      false,
    );
    assert.equal(
      isV1ResumableFailure({ hasLawfulTerminalResult: false }),
      false,
    );
  });
});


test("typed 429 failure Terminal carries resume command and reveals run id only there", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const runId = "run-resume-429-001";

    const result = await runAkRole(
      [
        "--model",
        "openai-codex/gpt-5.6-sol:high",
        "judge",
        "--project",
        project,
        "quota interrupted task",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const runDir = join(sessionDir, "..");
          // Production observation seam — not a direct recordTypedProviderHttpStatus stand-in.
          await observeTyped429ViaProductionHandler({
            runDirectory: runDir,
            provider: "openai-codex",
          });
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            // Deliberately non-quota wording — classification must not use prose.
            errorMessage: "upstream declined this request",
          });
          return {
            code: 1,
            stderr: "activation wrapper exited nonzero\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    assertRunIdOnlyInResumeCommand(result.terminal!, runId);
    // Presentation may rearrange labels; only require the command text appears and
    // the run ID does not appear outside that complete command string.
    const presented = stdout[0]!;
    const resumeCommand = result.terminal!.resume!.command;
    assert.equal(presented.includes(resumeCommand), true);
    const presentedWithoutCommand = presented.split(resumeCommand).join("");
    assert.equal(
      presentedWithoutCommand.includes(runId),
      false,
      "presented Terminal must not disclose run ID outside resume.command",
    );

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    // Durable observation + Error Artifact remain on disk even though public
    // Terminal omits path refs that would re-disclose the run ID.
    assert.deepEqual(await readTypedHttp429Observation(runDirectory), {
      httpStatus: 429,
      provider: "openai-codex",
    });
    const durable = await readRoleRunState(runDirectory, piDurablePrincipalAuthority);
    assert.equal(durable?.state, "resumable");
    assert.deepEqual(durable?.resumable, {
      httpStatus: 429,
      provider: "openai-codex",
    });
  });
});

test("quota-like prose without typed 429 is not resumable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const runId = "run-prose-not-resume-001";

    const result = await runAkRole(
      ["judge", "--project", project, "prose only"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          // No typed observation file. Only quota-like prose in errorMessage.
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: "HTTP 429 rate limited quota exhausted billing",
          });
          return {
            code: 1,
            stderr: "HTTP 429 rate limited\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.resume, undefined);
    const bookKey = resolveBookKeyFromGit(project);
    const durable = await readRoleRunState(
      join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`),
      piDurablePrincipalAuthority,
    );
    assert.equal(durable?.state, "terminal");
  });
});

test("lawful terminal result wins over typed 429 observation", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const runId = "run-lawful-wins-001";

    const result = await runAkRole(
      ["judge", "--project", project, "already settled"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const runDir = join(sessionDir, "..");
          await observeTyped429ViaProductionHandler({
            runDirectory: runDir,
            provider: "xai",
          });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: {
                  judgeStatus: "converged",
                  note: "completed despite earlier 429",
                },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge", details: { judgeStatus: "converged", note: "completed despite earlier 429" } },
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.resume, undefined);
    const bookKey = resolveBookKeyFromGit(project);
    const durable = await readRoleRunState(
      join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`),
      piDurablePrincipalAuthority,
    );
    assert.equal(durable?.state, "terminal");
  });
});

test("within-attempt earlier 429 does not qualify resume after a later non-429 response", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout } = captureIo();
    const runId = "run-within-attempt-stale-429-001";

    const result = await runAkRole(
      ["judge", "--project", project, "stale within-attempt 429"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          const runDir = join(sessionDir, "..");
          // First provider response is a qualifying 429.
          await observeTyped429ViaProductionHandler({
            runDirectory: runDir,
            provider: "openai-codex",
            httpStatus: 429,
          });
          // Later response in the same attempt is non-429 — must supersede.
          await observeTyped429ViaProductionHandler({
            runDirectory: runDir,
            provider: "openai-codex",
            httpStatus: 500,
          });
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: "upstream internal error",
          });
          return {
            code: 1,
            stderr: "provider_error\n",
            timedOut: false,
            args: [...args],
            knownFailure: {
              cause: "provider",
              identity: { name: "ProviderError", code: 500 },
              diagnostic: "upstream internal error",
            },
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.resume, undefined);
    assert.equal(result.terminal!.runId, runId);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    assert.equal(await readTypedHttp429Observation(runDirectory), undefined);
    assert.equal((await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state, "terminal");
    assert.equal(stdout.join("").includes("ak-role resume"), false);
  });
});

test("prior attempt 429 does not make a later non-429 failure resumable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-attempt-scope-001";
    const bookKey = resolveBookKeyFromGit(project);

    // Attempt 1: typed 429 → resumable.
    {
      const { io } = captureIo();
      const first = await runAkRole(
        ["judge", "--project", project, "first attempt quota"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDir, ".."),
              provider: "openai-codex",
            });
            await writeSessionProviderStop(sessionDir, {
              provider: "openai-codex",
              errorMessage: "HTTP 429",
            });
            return {
              code: 1,
              stderr: "provider_error\n",
              timedOut: false,
              args: [...args],
              knownFailure: {
                cause: "provider",
                identity: { name: "ProviderError", code: 429 },
                diagnostic: "HTTP 429",
              },
            };
          },
          }),
        },
      );
      assert.equal(first.exitCode, 1);
      assert.ok(first.terminal?.resume);
    }

    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    assert.equal((await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state, "resumable");
    assert.ok(await readTypedHttp429Observation(runDirectory));

    // Attempt 2 (resume): non-429 failure. Prior observation must not qualify resume.
    const { io, stdout } = captureIo();
    let resumeDispatches = 0;
    const second = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        resumeDispatches += 1;
        const sessionFile = args[args.indexOf("--session") + 1]!;
        // Bound principal remains; drop prior provider-stop so this attempt's
        // timeout is not reclassified from stale session identity.
        await writeFile(sessionFile, "\n", "utf8");
        // Deliberately do not write a fresh 429 observation.
        return {
          code: 1,
          stderr: "upstream timeout\n",
          timedOut: true,
          args: [...args],
        };
      },
      }),
    });

    assert.equal(resumeDispatches, 1);
    assert.equal(second.exitCode, 1);
    assert.ok(second.terminal);
    assert.equal(second.terminal!.resume, undefined);
    assert.equal(second.terminal!.runId, runId);
    assert.equal(second.terminal!.roleOutcome.kind, "failure");
    if (second.terminal!.roleOutcome.kind === "failure") {
      assert.equal(second.terminal!.roleOutcome.cause, "timeout");
    }
    assert.equal(await readTypedHttp429Observation(runDirectory), undefined);
    assert.equal((await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state, "terminal");
    // Presented output must not advertise a resume command after the non-429 attempt.
    assert.equal(stdout.join("").includes("ak-role resume"), false);
  });
});

test("lawful result with publication failure is not resumable even with attempt 429", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-lawful-publish-fail-001";
    const { io, stdout } = captureIo();

    const result = await runAkRole(
      ["judge", "--project", project, "lawful then publish fails under 429"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          // Block report.json publication after a lawful converged verdict.
          await mkdir(join(runDir, "artifacts", "report.json"), {
            recursive: true,
          });
          await mkdir(sessionDir, { recursive: true });
          await observeTyped429ViaProductionHandler({
            runDirectory: runDir,
            provider: "xai",
          });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: {
                  judgeStatus: "converged",
                  note: "lawful despite later publication failure",
                },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge", details: { judgeStatus: "converged", note: "lawful despite later publication failure" } },
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.resume, undefined);
    assert.equal(result.terminal!.runId, runId);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      // Publication errno retained; must not wash into a resumable provider 429 path.
      assert.equal(result.terminal!.roleOutcome.cause, "unrecognized");
      assert.equal(result.terminal!.roleOutcome.decisiveFacts.errorCode, "EISDIR");
    }
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    assert.equal((await readRoleRunState(runDirectory, piDurablePrincipalAuthority))?.state, "terminal");
    assert.equal(stdout.join("").includes("ak-role resume"), false);
  });
});

test("resumable Terminal redacts exact run id from diagnostic free text; durable artifact keeps it", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-diagnostic-disclosure-001";
    const { io, stdout, stderr } = captureIo();

    const result = await runAkRole(
      ["judge", "--project", project, "provider names the run"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sessionDir, ".."),
            provider: "openai-codex",
          });
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: `upstream quota for run ${runId}: HTTP 429`,
          });
          return {
            code: 1,
            stderr: `provider refused run ${runId} with HTTP 429\n`,
            timedOut: false,
            args: [...args],
            knownFailure: {
              cause: "provider",
              identity: { name: "ProviderError", code: 429 },
              diagnostic: `upstream quota for run ${runId}: HTTP 429`,
            },
          };
        },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assertRunIdOnlyInResumeCommand(result.terminal!, runId);
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(
        result.terminal!.roleOutcome.diagnostic.includes(runId),
        false,
        "typed Terminal diagnostic must not re-disclose exact run ID",
      );
      assert.equal(
        result.terminal!.roleOutcome.diagnostic.includes("[run-id]"),
        true,
      );
      assert.equal(
        String(result.terminal!.roleOutcome.decisiveFacts.diagnostic).includes(
          runId,
        ),
        false,
      );
    }

    const presented = `${stdout.join("")}${stderr.join("")}`;
    const resumeCommand = result.terminal!.resume!.command;
    assert.equal(presented.includes(resumeCommand), true);
    const presentedOutsideCommand = presented.split(resumeCommand).join("");
    assert.equal(
      presentedOutsideCommand.includes(runId),
      false,
      "presented Terminal/stderr must not disclose run ID outside resume.command",
    );

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const errorPath = join(runDirectory, "artifacts", "error.json");
    const errorBody = JSON.parse(await readFile(errorPath, "utf8")) as {
      runId?: string;
      diagnostic?: string;
    };
    // Private durable artifact retains original evidence, including exact run ID.
    assert.equal(errorBody.runId, runId);
    assert.equal(typeof errorBody.diagnostic, "string");
    assert.equal(errorBody.diagnostic!.includes(runId), true);
  });
});

test("resume restores admitted identity and exact Pi session without resubmitting instruction", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const attachmentSrc = join(home, "authority.md");
    await writeFile(attachmentSrc, "authority-bytes-v1\n", "utf8");
    const runId = "run-resume-restore-001";
    const instruction = "original admitted instruction must not be resubmitted";
    const openedPrincipals = new Set<string>();

    // First admission interrupted by typed 429.
    {
      const { io } = captureIo();
      const first = await runAkRole(
        [
          "judge",
          "--project",
          project,
          "--attach",
          attachmentSrc,
          instruction,
        ],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            openedPrincipals.add(args[args.indexOf("--session") + 1]!);
            await mkdir(sessionDir, { recursive: true });
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDir, ".."),
              provider: "xai",
            });
            await writeSessionProviderStop(sessionDir, {
              provider: "xai",
              errorMessage: "upstream declined",
            });
            return {
              code: 1,
              stderr: "fail\n",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.ok(first.terminal?.resume);
      // Mutate source attachment after admission — resume must keep frozen bytes.
      await writeFile(attachmentSrc, "authority-bytes-MUTATED\n", "utf8");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    // Simulate a resumable run-state written before sessionFile was persisted.
    const legacyStatePath = join(runDirectory, "run-state.json");
    const legacyState = JSON.parse(
      await readFile(legacyStatePath, "utf8"),
    ) as Record<string, unknown>;
    delete legacyState.sessionFile;
    await writeFile(legacyStatePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
    // The persisted principal survives project relocation and loss of Git topology.
    const movedProject = join(home, "moved-non-git-project");
    await rename(project, movedProject);
    await rm(join(movedProject, ".git"), { recursive: true, force: true });
    const admittedBefore = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as {
      instruction: string;
      attachments: Array<{ frozenPath: string; sha256: string }>;
    };
    assert.equal(admittedBefore.instruction, instruction);
    assert.equal(admittedBefore.attachments.length, 1);
    const frozenPath = admittedBefore.attachments[0]!.frozenPath;
    const frozenSha = admittedBefore.attachments[0]!.sha256;

    const { io, stdout, stderr } = captureIo();
    let resumeArgs: string[] | undefined;
    const resumed = await runAkRole(
      ["--model", "xai/grok-4.5:high", "resume", runId],
      {
        packageRoot,
        home,
        cwd: movedProject,
        credentials: { "openai-codex": true, xai: true },
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          resumeArgs = [...args];
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const sessionFile = args[args.indexOf("--session") + 1]!;
          openedPrincipals.add(sessionFile);
          assert.equal(sessionDir, sessionDirectory);
          assert.equal(sessionFile, join(sessionDirectory, "session.jsonl"));
          // Exact principal reopen — never directory-latest --continue.
          assert.equal(args.includes("--continue"), false);
          // Must not resubmit original instruction as a new prompt payload.
          assert.equal(args.includes(instruction), false);
          assert.equal(args.includes(RESUME_TRANSPORT_ENVELOPE), true);
          // Exact model override for this resume only.
          assert.equal(args[args.indexOf("--provider") + 1], "xai");
          assert.equal(args[args.indexOf("--model") + 1], "grok-4.5");
          assert.equal(args[args.indexOf("--thinking") + 1], "high");
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { judgeStatus: "converged", note: "resumed ok" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "judge", details: { judgeStatus: "converged", note: "resumed ok" } },
          };
        },
        }),
      },
    );

    assert.ok(resumeArgs, stderr.join(""));
    assert.equal(resumed.exitCode, 0);
    assert.ok(resumed.terminal);
    assert.equal(resumed.terminal!.roleOutcome.kind, "accepted");
    assert.equal(resumed.terminal!.runId, runId);
    assert.equal(resumed.terminal!.resume, undefined);
    assert.equal(stdout.length, 1);

    // Frozen attachment bytes unchanged after source mutation.
    const frozenBytes = await readFile(frozenPath, "utf8");
    assert.equal(frozenBytes, "authority-bytes-v1\n");
    const admittedAfter = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { attachments: Array<{ sha256: string }> };
    assert.equal(admittedAfter.attachments[0]!.sha256, frozenSha);

    const durable = await readRoleRunState(runDirectory, piDurablePrincipalAuthority);
    assert.equal(durable?.state, "terminal");
    assert.equal(durable?.sessionFile, join(sessionDirectory, "session.jsonl"));
    assert.deepEqual([...openedPrincipals], [
      join(sessionDirectory, "session.jsonl"),
    ]);
  });
});

test("resume model override is temporary and does not rewrite persistent config", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    // Seed persistent judge config.
    {
      const { io } = captureIo();
      const set = await runAkRole(
        ["config", "set", "judge", "openai-codex/gpt-5.6-sol:high"],
        { packageRoot, home, cwd: project, io },
      );
      assert.equal(set.exitCode, 0);
    }

    const runId = "run-temp-override-001";
    {
      const { io } = captureIo();
      await runAkRole(["judge", "--project", project, "hit 429"], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sessionDir, ".."),
            provider: "openai-codex",
          });
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: "declined",
          });
          return {
            code: 1,
            stderr: "x\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      });
    }

    const { io } = captureIo();
    await runAkRole(["--model", "xai/grok-4.5:medium", "resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
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
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
      }),
    });

    // Persistent config unchanged — temporary override only.
    const { io: io2, stdout } = captureIo();
    const cfg = await runAkRole(["config", "get", "judge"], {
      packageRoot,
      home,
      cwd: project,
      io: io2,
    });
    assert.equal(cfg.exitCode, 0);
    assert.equal(stdout.join("").includes("openai-codex/gpt-5.6-sol:high"), true);
    assert.equal(stdout.join("").includes("xai/grok-4.5"), false);
  });
});

test("resume model precedence: explicit --model beats admitted.model; model-less resume restores admitted.model incl thinking", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const instruction = "resume model precedence probe";

    async function admitResumable(runId: string) {
      const { io } = captureIo();
      const first = await runAkRole(
        ["--model", "xai/grok-4.5:high", "judge", "--project", project, instruction],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              const sessionDir = args[args.indexOf("--session-dir") + 1]!;
              await mkdir(sessionDir, { recursive: true });
              await observeTyped429ViaProductionHandler({
                runDirectory: join(sessionDir, ".."),
                provider: "xai",
              });
              await writeSessionProviderStop(sessionDir, {
                provider: "xai",
                errorMessage: "declined",
              });
              return {
                code: 1,
                stderr: "x\n",
                timedOut: false,
                args: [...args],
              };
            },
          }),
        },
      );
      assert.ok(first.terminal?.resume, "first admission must settle resumable");
    }

    // Run A: model-less resume must restore admitted.model including thinking.
    {
      const runId = "run-model-precedence-a";
      await admitResumable(runId);
      const { io } = captureIo();
      let modelLessArgs: string[] | undefined;
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            modelLessArgs = [...args];
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
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
              stderr: "",
              timedOut: false,
              args: [...args],
              sealedAcceptance: { role: "judge", details: { judgeStatus: "converged" } },
            };
          },
        }),
      });
      assert.ok(modelLessArgs, "model-less resume must dispatch a Pi turn");
      assert.equal(modelLessArgs[modelLessArgs.indexOf("--provider") + 1], "xai");
      assert.equal(modelLessArgs[modelLessArgs.indexOf("--model") + 1], "grok-4.5");
      assert.equal(modelLessArgs[modelLessArgs.indexOf("--thinking") + 1], "high");
      assert.equal(resumed.exitCode, 0);
    }

    // Run B: an explicit CLI --model on resume must beat admitted.model.
    {
      const runId = "run-model-precedence-b";
      await admitResumable(runId);
      const { io, stdout } = captureIo();
      let explicitArgs: string[] | undefined;
      const resumed = await runAkRole(
        ["--model", "openai-codex/gpt-5.6-sol:off", "resume", runId],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              explicitArgs = [...args];
              const sessionDir = args[args.indexOf("--session-dir") + 1]!;
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
                stderr: "",
                timedOut: false,
                args: [...args],
                sealedAcceptance: { role: "judge", details: { judgeStatus: "converged" } },
              };
            },
          }),
        },
      );
      assert.ok(explicitArgs, "explicit-model resume must dispatch a Pi turn");
      assert.equal(explicitArgs[explicitArgs.indexOf("--provider") + 1], "openai-codex");
      assert.equal(explicitArgs[explicitArgs.indexOf("--model") + 1], "gpt-5.6-sol");
      assert.equal(explicitArgs[explicitArgs.indexOf("--thinking") + 1], "off");
      assert.equal(resumed.exitCode, 0);
      assert.equal(stdout.join("").includes("xai/grok-4.5"), false);
    }
  });
});

test("unknown terminal and non-resumable ids reject without replay", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    let dispatches = 0;
    const runner = async (args: readonly string[]) => {
      dispatches += 1;
      return {
        code: 0,
        stderr: "",
        timedOut: false,
        args: [...args],
      };
    };

    {
      const { io, stdout, stderr } = captureIo();
      const unknown = await runAkRole(["resume", "does-not-exist"], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: runner,
        }),
      });
      assert.equal(unknown.exitCode, 2);
      assert.equal(stdout.length, 0);
      assert.equal(stderr.length >= 1, true);
      assert.equal(dispatches, 0);
    }

    // Create a terminal (non-resumable) failure run.
    const terminalId = "run-terminal-reject-001";
    {
      const { io } = captureIo();
      await runAkRole(["judge", "--project", project, "activation fail"], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => terminalId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          return {
            code: 1,
            stderr: "activation boom\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      });
    }
    dispatches = 0;
    {
      const { io, stdout } = captureIo();
      const rejected = await runAkRole(["resume", terminalId], {
        packageRoot,
        home,
        cwd: project,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: runner,
        }),
      });
      assert.equal(rejected.exitCode, 2);
      assert.equal(stdout.length, 0);
      assert.equal(dispatches, 0);
    }

    // Unit: loadResumableJudgeRun rejects terminal/non-resumable.
    await assert.rejects(
      () => loadResumableJudgeRun(home, "missing", piDurablePrincipalAuthority),
      /unknown role run id/,
    );
  });
});

test("concurrent resume cannot create a second writer or dispatch", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-lease-001";
    const { io } = captureIo();
    await runAkRole(["judge", "--project", project, "lease setup"], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => runId,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        await observeTyped429ViaProductionHandler({
          runDirectory: join(sessionDir, ".."),
          provider: "openai-codex",
        });
        await writeSessionProviderStop(sessionDir, {
          provider: "openai-codex",
          errorMessage: "declined",
        });
        return {
          code: 1,
          stderr: "x\n",
          timedOut: false,
          args: [...args],
        };
      },
      }),
    });

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const lockPath = join(runDirectory, "writer.lock");
    const lease = await acquireRunWriterLease(runDirectory);
    let dispatches = 0;
    try {
      const { io: io2, stdout, stderr } = captureIo();
      const blocked = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: io2,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          dispatches += 1;
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      });
      // Concurrent resume rejected before second dispatch.
      assert.equal(dispatches, 0);
      assert.equal(stdout.length, 0);
      assert.equal(stderr.length >= 1, true);
      assert.notEqual(blocked.exitCode, 0);
    } finally {
      await lease.release();
    }

    // Direct lease double-acquire also fails closed.
    const first = await acquireRunWriterLease(runDirectory);
    await assert.rejects(
      () => acquireRunWriterLease(runDirectory),
      (error: unknown) => error instanceof RunWriterLeaseHeldError,
    );
    await first.release();

    for (const unparseable of ["", "123junk", "123\njunk"]) {
      await writeFile(lockPath, unparseable, "utf8");
      const { io: ioUnparseable } = captureIo();
      const blocked = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: ioUnparseable,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            dispatches += 1;
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        }),
      });
      assert.equal(dispatches, 0);
      assert.notEqual(blocked.exitCode, 0);
      assert.equal(await readFile(lockPath, "utf8"), unparseable);
    }

    const child = spawn("sleep", ["30"]);
    const pid = child.pid;
    assert.ok(typeof pid === "number" && pid > 0);
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await writeFile(lockPath, `${pid}\n`, "utf8");
    {
      const { io: ioDead } = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io: ioDead,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            dispatches += 1;
            const sessionPath = args[args.indexOf("--session") + 1]!;
            await writeFile(
              sessionPath,
              `${JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: JUDGE_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: { judgeStatus: "converged", note: "dead lock reclaimed" },
                },
              })}\n`,
              "utf8",
            );
            return {
              code: 0,
              stderr: "",
              timedOut: false,
              args: [...args],
              sealedAcceptance: {
                role: "judge",
                details: { judgeStatus: "converged", note: "dead lock reclaimed" },
              },
            };
          },
        }),
      });
      assert.equal(dispatches, 1);
      assert.equal(resumed.exitCode, 0);
      assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
      assert.equal(resumed.staleWriterLeaseReclaimed, true);
    }
  });
});

test("#418 lease release reports the true cleanup-failure cause via the diagnostic seam", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-lease-cleanup-cause@judge");
    await mkdir(runDirectory, { recursive: true });
    const diagnostics: string[] = [];
    const lease = await acquireRunWriterLease(runDirectory, (line) => diagnostics.push(line));
    // Force a truthful non-EACCES unlink failure: replace the lock file with a
    // directory so release's unlink fails (EISDIR on Linux, EPERM on macOS).
    // The diagnostic must carry the real identity — never a guessed
    // EACCES/lease-held label.
    const lockPath = join(runDirectory, "writer.lock");
    await unlink(lockPath);
    await mkdir(lockPath);
    await lease.release();
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /writer lease lock cleanup failed/);
    assert.match(diagnostics[0]!, / code=(EPERM|EISDIR)/);
    assert.match(diagnostics[0]!, /writer\.lock/);
    await rm(lockPath, { recursive: true });
    // Best-effort continue semantics preserved: next acquire succeeds.
    const next = await acquireRunWriterLease(runDirectory);
    await next.release();
  });
});

test("#418 lease release stays best-effort when the diagnostic sink throws", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-lease-sink-throws@judge");
    await mkdir(runDirectory, { recursive: true });
    let sinkCalls = 0;
    const lease = await acquireRunWriterLease(runDirectory, () => {
      sinkCalls += 1;
      throw new Error("diagnostic sink exploded");
    });
    // Force a truthful non-EACCES unlink failure (same seam as above).
    const lockPath = join(runDirectory, "writer.lock");
    await unlink(lockPath);
    await mkdir(lockPath);
    // Contract: release() resolves despite the throwing sink — no propagation.
    await lease.release();
    assert.equal(sinkCalls, 1);
    await rm(lockPath, { recursive: true });
  });
});

test("#418 lease release recovery path emits no false diagnostic", async () => {
  await withTempHome(async (home) => {
    const runDirectory = join(home, "runs", "run-lease-recover@judge");
    await mkdir(runDirectory, { recursive: true });
    const diagnostics: string[] = [];
    const lease = await acquireRunWriterLease(runDirectory, (line) => diagnostics.push(line));
    // EACCES unlink → chmod retry recovers; the success path must stay silent.
    await chmod(runDirectory, 0o500);
    try {
      await lease.release();
      assert.equal(diagnostics.length, 0);
    } finally {
      await chmod(runDirectory, 0o755);
    }
  });
});

test("settleJudgeFailureTerminalResult attaches resume only for typed 429", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bookKey = resolveBookKeyFromGit(project);
    const runId = "run-settle-resume-unit";
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    const admittedRequestPath = join(runDirectory, "admitted-request.json");
    await writeFile(admittedRequestPath, "{}\n", "utf8");
    const admitted = {
      role: "judge" as const,
      runId,
      bookKey,
      projectRoot: project,
      instruction: "x",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      principal: fixturePrincipal(sessionDirectory, sessionFile),
      admittedRequestPath,
    };
    await markRunAdmitted(admitted, piDurablePrincipalAuthority);
    await markRunResumable(runDirectory, {
      httpStatus: 429,
      provider: "xai",
    });

    const withResume = await settleJudgeFailureTerminalResult(
      admitted,
      { cause: "provider", diagnostic: "upstream declined" },
      piDurablePrincipalAuthority,
      {
        resume: {
          command: renderResumeCommand(runId),
        },
      },
    );
    assertRunIdOnlyInResumeCommand(withResume, runId);
    assert.equal(withResume.artifacts.length, 0);

    await markRunTerminal(runDirectory);
    const without = await settleJudgeFailureTerminalResult(admitted, {
      cause: "activation",
      diagnostic: "boom",
    }, piDurablePrincipalAuthority);
    assert.equal(without.resume, undefined);
    assert.equal(without.runId, runId);
    assert.ok(without.artifacts.length > 0);
  });
});

test("host-issued sessionFile coordinate reaches activation and resume execution seams", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-session-principal-001";
    // Host issues a distinctive sessionFile coordinate (not the Pi default name).
    // Contract under test: the opaque frozen wire is the principal on resume,
    // not public-cli rebuilt objects — alternate authority brands decode output
    // to distinguish frozen wire (pass) from reconstructed coordinates (fail).
    const principalAuthority = {
      issue(request: Parameters<typeof piDurablePrincipalAuthority.issue>[0]) {
        const base = piDurablePrincipalAuthority.issue(request);
        const coords = piDurablePrincipalAuthority.decode(base);
        return fixturePrincipal(
          coords.sessionDirectory,
          join(coords.sessionDirectory, "host-issued-principal.jsonl"),
        );
      },
      decode(value: unknown) {
        const coords = piDurablePrincipalAuthority.decode(value);
        return Object.assign({}, coords, { __durableCoords: true });
      },
      async isAvailable(principal: Parameters<typeof piDurablePrincipalAuthority.isAvailable>[0]) {
        if (
          principal !== null &&
          typeof principal === "object" &&
          "__durableCoords" in (principal as Record<string, unknown>)
        ) {
          return false;
        }
        return piDurablePrincipalAuthority.isAvailable(principal);
      },
    };

    {
      const { io } = captureIo();
      const first = await runAkRole(
        ["judge", "--project", project, "bind exact session"],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => runId,
          principalAuthority,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = (args as string[])[(args as string[]).indexOf("--session-dir") + 1]!;
            const sessionPath = (args as string[])[(args as string[]).indexOf("--session") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await observeTyped429ViaProductionHandler({
              runDirectory: join(sessionDir, ".."),
              provider: "openai-codex",
            });
            await writeSessionProviderStop(sessionDir, {
              provider: "openai-codex",
              errorMessage: "rate limited",
            });
            await writeFile(sessionPath, "\n", "utf8");
            return {
              code: 1,
              stderr: "fail\n",
              timedOut: false,
              args: [...args],
            };
          },
          }),
        },
      );
      assert.ok(first.terminal?.resume);
      assert.equal(first.exitCode, 1);
      assert.equal(first.terminal?.roleOutcome.kind, "failure");
    }

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const durable = await readRoleRunState(runDirectory, principalAuthority);
    assert.ok(durable);
    assert.equal(durable.sessionFile.endsWith("/session/host-issued-principal.jsonl"), true);
    assert.equal(durable.state, "resumable");

    // Host-denied availability must fail honestly without a typed accepted Terminal.
    const blockingAuthority = {
      issue: principalAuthority.issue,
      decode: principalAuthority.decode,
      async isAvailable() {
        return false;
      },
    };
    {
      const { io } = captureIo();
      const blocked = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        principalAuthority: blockingAuthority,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => ({
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
        }),
        }),
      });
      assert.equal(blocked.exitCode, 2);
      assert.equal(blocked.terminal, undefined);
    }

    // Successful resume with opaque frozen wire must reopen the same host-issued sessionFile.
    const { io } = captureIo();
    const resumed = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      principalAuthority,
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        const sessionPath = (args as string[])[(args as string[]).indexOf("--session") + 1]!;
        await writeFile(
          sessionPath,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { judgeStatus: "converged", note: "principal ok" },
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
          sealedAcceptance: { role: "judge", details: { judgeStatus: "converged", note: "principal ok" } },
        };
      },
      }),
    });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    const after = await readRoleRunState(runDirectory, principalAuthority);
    assert.equal(after?.state, "terminal");
    assert.equal(after?.sessionFile.endsWith("/session/host-issued-principal.jsonl"), true);
  });
});

test("resume rejects when the exact Pi session principal is unavailable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-missing-principal-001";
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const sessionDirectory = join(runDirectory, "session");
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    const admittedRequestPath = join(runDirectory, "admitted-request.json");
    await writeFile(
      admittedRequestPath,
      `${JSON.stringify({
        role: "judge",
        instruction: "x",
        instructionEmpty: false,
        attachments: [],
      })}\n`,
      "utf8",
    );
    await markRunAdmitted({
      role: "judge",
      runId,
      bookKey,
      projectRoot: project,
      instruction: "x",
      instructionEmpty: false,
      attachments: [],
      runDirectory,
      principal: fixturePrincipal(sessionDirectory, sessionFile),
      admittedRequestPath,
    }, piDurablePrincipalAuthority);
    await markRunResumable(runDirectory, {
      httpStatus: 429,
      provider: "xai",
    });
    // Principal path is bound but the file itself is missing.

    await assert.rejects(
      () => loadResumableJudgeRun(home, runId, piDurablePrincipalAuthority),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Pi session principal is unavailable"),
    );

    const { io, stdout, stderr } = captureIo();
    let dispatches = 0;
    const blocked = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
        dispatches += 1;
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
      }),
    });
    assert.equal(dispatches, 0);
    assert.equal(stdout.length, 0);
    assert.notEqual(blocked.exitCode, 0);
    assert.equal(
      stderr.join("").includes("Pi session principal is unavailable"),
      true,
    );
  });
});

test("typed 429 without a session principal is not offered as resumable", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-429-no-session-file";

    const { io, stdout } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "no session file"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          // Typed 429 observation only — no session principal materialised.
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sessionDir, ".."),
            provider: "xai",
          });
          return {
            code: 1,
            stderr: "fail\n",
            timedOut: false,
            args: [...args],
          };
        },
        }),
      },
    );

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.terminal?.resume, undefined);
    assert.equal(stdout.join("").includes("ak-role resume"), false);

    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      bookKey,
      "runs",
      `${runId}@judge`,
    );
    const durable = await readRoleRunState(runDirectory, piDurablePrincipalAuthority);
    assert.equal(durable?.state, "terminal");
  });
});

/** #471 transport on existing resume owner: opaque last-argv + bare -- + extras reject. */
test("#471 resume opaque message is last argv; bare -- dispatches; extras reject", async () => {
  await withTempHome(async (home) => {
    type Role = "judge" | "coder" | "fixer" | "reviewer" | "merger";
    const creds = { "openai-codex": true, xai: true } as const;

    async function conflicted(root: string): Promise<void> {
      seedGitProject(root);
      await writeFile(join(root, "same.txt"), "base\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-m", "base"], { cwd: root });
      execFileSync("git", ["checkout", "-b", "source"], { cwd: root });
      await writeFile(join(root, "same.txt"), "source\n", "utf8");
      execFileSync("git", ["commit", "-am", "source"], { cwd: root });
      execFileSync("git", ["checkout", "main"], { cwd: root });
      await writeFile(join(root, "same.txt"), "target\n", "utf8");
      execFileSync("git", ["commit", "-am", "target"], { cwd: root });
      assert.throws(() => execFileSync("git", ["merge", "--no-edit", "source"], { cwd: root }));
      assert.equal(
        execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        "same.txt",
      );
    }

    function admitArgs(role: Role, project: string): string[] {
      if (role === "judge") return ["judge", "--project", project, "admit"];
      if (role === "coder") return ["coder", "plan", "--project", project, "admit"];
      if (role === "fixer") return ["fixer", "plan", "--project", project, "admit"];
      if (role === "reviewer") return ["reviewer", "--project", project, "--base", "main", "admit"];
      return ["merger", "--project", project, "admit"];
    }

    async function admit429(role: Role, runId: string, project: string): Promise<{
      sessionFile: string;
      sessionDirectory: string;
    }> {
      const { io } = captureIo();
      const first = await runAkRole(admitArgs(role, project), {
        packageRoot,
        home,
        cwd: project,
        credentials: creds,
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sd = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sd, { recursive: true });
          await writeFile(join(sd, "session.jsonl"), "", "utf8");
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sd, ".."),
            provider: "xai",
          });
          return { code: 1, stderr: "quota", timedOut: false, args: [...args] };
        },
        }),
      });
      assert.ok(first.terminal?.resume, `${role}/${runId} must be resumable`);
      const sessionDirectory = join(
        home,
        ".ak-roles",
        "books",
        resolveBookKeyFromGit(project),
        "runs",
        `${runId}@${role}`,
        "session",
      );
      return { sessionDirectory, sessionFile: join(sessionDirectory, "session.jsonl") };
    }

    const cases: ReadonlyArray<{
      role: Role;
      runId: string;
      message?: string;
      conflict?: true;
    }> = [
      { role: "judge", runId: "471-j-plain", message: "owner says proceed" },
      { role: "judge", runId: "471-j-model", message: "--model" },
      { role: "judge", runId: "471-j-empty", message: "" },
      { role: "judge", runId: "471-j-ws", message: "  ruling with\nnewline  " },
      { role: "judge", runId: "471-j-dd", message: "--" },
      { role: "coder", runId: "471-c", message: "coder owner note" },
      { role: "fixer", runId: "471-f", message: "fixer owner note" },
      { role: "reviewer", runId: "471-r", message: "reviewer owner note" },
      { role: "merger", runId: "471-m", message: "merger owner note", conflict: true },
      { role: "judge", runId: "471-j-bare" },
    ];

    for (const c of cases) {
      const project = join(home, `p-${c.runId}`);
      await mkdir(project, { recursive: true });
      if (c.conflict) await conflicted(project);
      else seedGitProject(project);
      const admitted = await admit429(c.role, c.runId, project);
      const resumeArgv =
        c.message === undefined ? ["resume", c.runId] : ["resume", c.runId, c.message];
      const { io, stderr } = captureIo();
      let seen: string[] | undefined;
      let n = 0;
      await runAkRole(resumeArgv, {
        packageRoot,
        home,
        cwd: project,
        credentials: creds,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          n += 1;
          seen = [...args];
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
        }),
      });
      assert.equal(n, 1, `${c.runId}: dispatch; ${stderr.join("")}`);
      assert.ok(seen);
      assert.equal(seen[seen.indexOf("--session") + 1], admitted.sessionFile);
      assert.equal(seen[seen.indexOf("--session-dir") + 1], admitted.sessionDirectory);
      assert.equal(
        seen.at(-1),
        c.message === undefined ? RESUME_TRANSPORT_ENVELOPE : c.message,
      );
    }

    // extras → usage reject, dispatch=0 (including `-- extra`)
    {
      const project = join(home, "p-extra");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const runId = "471-extra";
      await admit429("judge", runId, project);
      for (const bad of [
        ["resume", runId, "one", "two"],
        ["resume", runId, "--", "extra"],
      ] as const) {
        const { io, stderr } = captureIo();
        let n = 0;
        const rejected = await runAkRole([...bad], {
          packageRoot,
          home,
          cwd: project,
          credentials: creds,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            n += 1;
            return { code: 0, stderr: "", timedOut: false, args: [...args] };
          },
          }),
        });
        assert.equal(n, 0, bad.join(" "));
        assert.notEqual(rejected.exitCode, 0);
        assert.match(stderr.join(""), /usage: ak-role resume/);
      }
    }
  });
});
