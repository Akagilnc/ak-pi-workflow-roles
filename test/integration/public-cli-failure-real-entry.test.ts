// #107/#373 public-CLI acceptance tracer — 公开入口因果身份家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
import { ExplicitInternalActivationError } from "../../src/host-contracts.ts";
import { exitCodeForTerminalOutcome, formatFailureStderrDiagnostic, isLawfulTypedTerminalOutcome } from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";
import { seedDoctorIssueRuns } from "../helpers/doctor-fixtures.ts";

test("public report publication failures retain typed errno identity", async () => {
  // #953 clears conventional faces before rewrite, so report.json-as-directory no
  // longer reaches writeFile. Lock artifacts/ instead — clear no-ops on absent
  // faces; writeFile then EACCES. Audit-incomplete publication path abolished (#475).
  const rows = [
    {
      label: "EACCES on report publication",
      plant: async (runDir: string) => {
        const artifactsDir = join(runDir, "artifacts");
        await mkdir(artifactsDir, { recursive: true });
        await chmod(artifactsDir, 0o555);
        return artifactsDir;
      },
      seedSession: async (sessionFile: string) => {
        await writeFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { status: "converged" },
            },
          })}\n`,
          "utf8",
        );
      },
      expectedCode: "EACCES",
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      let lockedArtifactsDir: string | undefined;
      try {
        const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "lawful then publish fails"],
          {
            packageRoot,
            home,
            cwd: project,
            createRunId: () => "run-audit-artifact-errno-001",
            io,
            roleTurnHost: roleTurnHostFromLegacyPiRunner({
              packageRoot,
              principalAuthority: piDurablePrincipalAuthority,
              piRunner: async (args) => {
              const sessionDir = args[args.indexOf("--session-dir") + 1]!;
              const runDir = join(sessionDir, "..");
              lockedArtifactsDir = await row.plant(runDir);
              await mkdir(sessionDir, { recursive: true });
              await row.seedSession(join(sessionDir, "session.jsonl"));
              return {
                code: 0,
                stdout: "",
                stderr: "",
                timedOut: false,
                args: [...args],
                sealedAcceptance: {
                  role: "judge" as const,
                  details: { status: "converged" },
                },
              };
            },
            }),
          },
        );
        assert.equal(result.exitCode, 1, row.label);
        assert.equal(stdout.length, 1, row.label);
        assert.equal(stderr.length, 1, row.label);
        assert.ok(result.terminal, row.label);
        const outcome = result.terminal!.roleOutcome;
        assert.equal(outcome.kind, "failure", row.label);
        if (outcome.kind !== "failure") throw new Error("expected publication failure");
        // Must not wash publication errno into generic output absence.
        assert.equal(outcome.cause, undefined, row.label);
        assert.notEqual(outcome.cause, "output", row.label);
        assert.equal(outcome.decisiveFacts.errorCode, row.expectedCode, row.label);
        const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
        assert.ok(errorRef, row.label);
        const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
          cause: string;
          identity?: { name?: string; code?: string | number };
          diagnostic: string;
        };
        assert.equal(errorBody.cause, undefined, row.label);
        assert.equal(errorBody.identity?.code, row.expectedCode, row.label);
        assert.ok(errorBody.diagnostic.length > 0, row.label);
      } finally {
        if (lockedArtifactsDir !== undefined) {
          try {
            await chmod(lockedArtifactsDir, 0o755);
          } catch {
            // cleanup best-effort
          }
        }
      }
    });
  }
});
// Post-admission zero-exit matrix: admission succeeded, the pi child exits
// zero, and no accepted ledger row exists — a missing session transcript, or
// an unsealed toolResult with a status code does not recognize. #836: none
// of these is a code-side rejection of what the role said; with no typed
// host/runner failure signal either, every shape settles as the same honest
// no_receipt (lawful, exit 0) — never an invented session/output failure.
test("zero-exit post-admission runs with no accepted row settle honestly as no_receipt", async () => {
  const rows = [
    {
      label: "missing session",
      argv: (project: string) => ["judge", "--model", "test/caller-seat:high", "--project", project, "no session bytes"],
      runId: "run-session-missing-001",
      seedSession: async (_sessionFile: string) => {
        // Admitted session directory exists but holds no transcript.
      },
    },
    {
      label: "unsealed coder toolResult with a status coder does not recognize",
      argv: (project: string) => ["coder", "--model", "test/caller-seat:high", "apply", "--project", project, "bogus details"],
      runId: "run-coder-output-bogus-001",
      seedSession: async (sessionFile: string) => {
        await writeFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: CODER_OUTPUT_TOOL_NAME,
              isError: false,
              details: { status: "not-a-coder-status" },
            },
          })}\n`,
          "utf8",
        );
      },
    },
    {
      label: "unsealed judge toolResult with a status judge does not recognize",
      argv: (project: string) => ["judge", "--model", "test/caller-seat:high", "--project", project, "bogus details"],
      runId: "run-output-bogus-001",
      seedSession: async (sessionFile: string) => {
        await writeFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { status: "bogus" },
            },
          })}\n`,
          "utf8",
        );
      },
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stderr } = captureIo();
      const result = await runAkRole(row.argv(project), {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => row.runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await row.seedSession(join(sessionDir, "session.jsonl"));
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
        }),
      });
      assert.equal(result.exitCode, 0, row.label);
      assert.equal(result.terminal?.roleOutcome.kind, "no_receipt", row.label);
      assert.equal(stderr.length, 0, row.label);
    });
  }
});
test("production knownFailure channel reaches settlement as provider with typed identity", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // Resolved runner result — production-owned channel on ExplicitInternalPiResult,
    // not an ad-hoc thrown Error property and not stderr-prose inference.
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "provider down"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-provider-channel-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
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
        }),
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
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "provider throw"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-provider-throw-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async () => {
          throw new ExplicitInternalActivationError("model upstream 503", {
            knownCause: "provider",
            name: "ProviderUnavailableError",
            code: "PROVIDER_UNAVAILABLE",
          });
        },
        }),
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
test("credential catalog absence does not relabel an unrelated nonzero host exit", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // The catalog says the credential is absent, but this invocation provides no
    // typed evidence that auth caused its nonzero exit.
    const result = await runAkRole(
      ["--model", "xai/grok-4:off", "judge", "--project", project, "empty auth"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": false, xai: false },
        createRunId: () => "run-credential-boundary-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
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
        }),
      },
    );
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "activation",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorName, "MissingProviderCredential");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      identity?: { name?: string; code?: string | number };
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "activation");
    assert.notEqual(errorBody.identity?.name, "MissingProviderCredential");
    assert.equal(typeof errorBody.diagnostic, "string");
    assert.ok(errorBody.diagnostic.length > 0);
    assert.ok(stderr[0]!.length > 0);
  });
});
test("typed empty-auth host failure settles as MissingProviderCredential (#987)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    // #987: pre-dispatch local auth checker deleted — host must be attempted;
    // the host's per-invocation knownFailure supplies MissingProviderCredential.
    let hostTurns = 0;
    const result = await runAkRole(
      ["--model", "xai/grok-4:off", "judge", "--project", project, "probe empty auth"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": false, xai: false },
        createRunId: () => "run-default-empty-auth-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            hostTurns += 1;
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
            return {
              code: 1,
              stderr: "No API key found for the selected model.",
              timedOut: false,
              args: [...args],
              knownFailure: {
                cause: "provider",
                identity: { name: "MissingProviderCredential", code: "xai" },
              },
            };
          },
        }),
      },
    );
    assert.ok(hostTurns >= 1, `empty credentials must not pre-block host dispatch (hostTurns=${hostTurns})`);
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      identityName: "MissingProviderCredential",
      identityCode: "xai",
    });
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
    assert.ok(stderr[0]!.length > 0);
  });
});
test("lawful terminal preferred over child nonzero exit (no wash into failure)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
    let config = { seats: {} };
    for (const role of ["notary", "auditor"] as const) config = setPersistentSeatConfig(config, role, seat);
    await savePublicCliConfig(config, home);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "already settled"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-prefer-lawful-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
          const role = argvFlagValue(args, "--ak-role");
          if (role === "notary" || role === "auditor") {
            return scriptedTerminatingToolSession({
              role, toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : AUDITOR_OUTPUT_TOOL_NAME,
              details: { status: "converged" },
            })(args, options);
          }
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
                details: { status: "converged" },
              },
            })}\n`,
            "utf8",
          );
          return {
            code: 1,
            stderr: "late host noise\n",
            timedOut: false,
            args: [...args],
            sealedAcceptance: {
              role: "judge" as const,
              details: { status: "converged" },
            },
          };
        },
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    if (result.terminal!.roleOutcome.kind !== "accepted") throw new Error("expected accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal!.roleOutcome), ["converged"]);
    assert.equal(result.terminal!.runId, "run-prefer-lawful-001");
  });
});
