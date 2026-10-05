import { historyPayloads, statePayloads, terminalBodyAt, lockCurrentJson, unlockCurrentJson, runLogPayloads } from "../helpers/run-dossier-fixture.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
// #107/#373 public-CLI acceptance tracer — 公开入口因果身份家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { CODER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { configurePassingReviewSeats, withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE } from "../../src/public-cli/post-admission.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { payloadFacts, payloadStatus, payloadStatusSequence , objectPayloads} from "../helpers/terminal-payload.ts";
import { ExplicitInternalActivationError } from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
} from "../helpers/failure-settlement-kit.ts";

test("public report publication failure stays beside the accepted terminal", async () => {
  // Lock current.json after the turn so the terminal write fails. The host already
  // accepted; that terminal stays, and the write failure is a cleanup diagnostic.
  // Collector: a seat with no gate officers, so the terminal write is the only
  // dossier write between the turn and the leg's own lawful persist.
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    let lockedCurrent: string | undefined;
    const runId = "run-audit-artifact-errno-001";
    const details = {
      host: "github.com",
      repository: "acme/widgets",
      prNumber: 1168,
      prState: "OPEN",
      manifestDigest: "role-submitted-optional",
      groups: [],
      unfinishedReasons: [],
      ticketNumber: 1171,
    };
    try {
      const inner = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: COLLECTOR_OUTPUT_TOOL, isError: false, details } })}\n`,
            "utf8",
          );
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
            sealedAcceptance: { role: "collector" as const, details },
          };
        },
      });
      const result = await runAkRole(
        ["collector", "--model", "test/caller-seat:high", "--pr", "1168", "--repo", "acme/widgets", "--project", project],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: false },
          createRunId: () => runId,
          // #1171: publication-lock injects after seal; bind up front so board
          // discovery / soft-reask are not owed and relocate does not race the
          // locked current.json plant. Intended seam stays terminal render EACCES.
          boundTicketNumber: 1171,
          io,
          roleTurnHost: {
            executeTurn: async (request) => {
              const out = await inner.executeTurn(request);
              // The seal is on the record; the leg's terminal write is next.
              lockedCurrent = join(request.runDirectory, "current.json");
              lockCurrentJson(dirname(lockedCurrent));
              return out;
            },
          },
        },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.runId, runId);
      const { findRunDirectoryById } = await import("../../src/public-cli/run-lifecycle.ts");
      const runDirectory =
        (await findRunDirectoryById(home, runId))
        ?? join(
          home,
          ".ak-roles",
          "books",
          resolveBookKeyFromGit(project),
          "unbound",
          "runs",
          `${runId}@collector`,
        );
      const noteText = (await readFile(join(runDirectory, "session", "session.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } })
        .find((entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE)
        ?.data?.diagnostic;
      assert.equal(typeof noteText, "string");
      // The injected failure really fired: the accepted terminal FACT is a history
      // row, but its rendering was refused (current.json is still the planted directory).
      const recorded = statePayloads<{ face?: string }>(runDirectory, "terminal");
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]!.face, "report");
      assert.equal(statSync(join(runDirectory, "current.json")).isDirectory(), true);
    } finally {
      if (lockedCurrent !== undefined) {
        try {
          unlockCurrentJson(dirname(lockedCurrent));
        } catch {
          // cleanup best-effort
        }
      }
    }
  });
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
      // The leg's terminal section says the same, with the no_receipt face.
      const role = row.argv(project)[0]!;
      const runDirectory = join(
        home, ".ak-roles", "books", resolveBookKeyFromGit(project), "unbound", "runs", `${row.runId}@${role}`,
      );
      const noReceipt = terminalBodyAt(join(runDirectory, "current.json"), "no_receipt") as {
        role?: string;
        runId?: string;
        outcome?: { kind?: string };
      };
      assert.equal(noReceipt.role, role, row.label);
      assert.equal(noReceipt.runId, row.runId, row.label);
      assert.equal(noReceipt.outcome?.kind, "no_receipt", row.label);
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
    const hostDiagnostic = "host own diagnostic";
    const hostStderr = "activation wrapper exited nonzero\nsecond line\n";
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
            code: 17,
            signal: "SIGTERM",
            timedOut: true,
            // Independent of the typed diagnostic. Both stay.
            stderr: hostStderr,
            args: [...args],
            knownFailure: {
              cause: "provider",
              diagnostic: hostDiagnostic,
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
      diagnosticEquals: hostDiagnostic,
      identityName: "ProviderUnavailableError",
      identityCode: "PROVIDER_UNAVAILABLE",
    });
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind !== "failure") return;
    assert.equal(result.terminal!.roleOutcome.cause, "provider");
    assert.equal(result.terminal!.roleOutcome.diagnostic, hostDiagnostic);
    const facts = result.terminal!.roleOutcome.decisiveFacts;
    assert.equal(facts.errorName, "ProviderUnavailableError");
    assert.equal(facts.errorCode, "PROVIDER_UNAVAILABLE");
    assert.equal(facts.stderr, hostStderr);
    const packageFact = facts.packageFact as { exitCode?: number; timedOut?: boolean; signal?: string };
    assert.equal(packageFact.exitCode, 17);
    assert.equal(packageFact.timedOut, true);
    assert.equal(packageFact.signal, "SIGTERM");
    assert.equal(stderr.length, 1);
    assert.equal(stderr[0]?.includes(hostStderr), true);
    const errorRef = result.terminal!.artifacts.find((artifact) => artifact.kind === "error");
    const errorBody = terminalBodyAt(errorRef!.path, "error") as {
      diagnostic?: string;
      stderr?: string;
      packageFact?: { exitCode?: number; timedOut?: boolean; signal?: string };
    };
    assert.equal(errorBody.diagnostic, hostDiagnostic);
    assert.equal(errorBody.stderr, hostStderr);
    assert.equal(errorBody.packageFact?.exitCode, 17);
    assert.equal(errorBody.packageFact?.timedOut, true);
    assert.equal(errorBody.packageFact?.signal, "SIGTERM");
    const history = historyPayloads<{
      outcome?: { stderr?: string; diagnostic?: string; packageFact?: { exitCode?: number } };
    }>(dirname(errorRef!.path), "attempt-history").map((row) => row.outcome);
    assert.equal(history.at(-1)?.diagnostic, hostDiagnostic);
    assert.equal(history.at(-1)?.stderr, hostStderr);
    assert.equal(history.at(-1)?.packageFact?.exitCode, 17);
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
    const hostStderr = [
      "No API key found for the selected model.",
      "",
      "Use /login to log into a provider via OAuth or API key. See:",
      "  /tmp/example-docs/alpha.md",
      "  /tmp/example-docs/beta.md",
    ].join("\n");
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
            stderr: hostStderr,
            timedOut: false,
            args: [...args],
            // deliberately omit knownFailure — credential channel must supply cause
          };
        },
        }),
      },
    );
    // No typed confirmation here, so no cause is claimed; the point of the case
    // is that credential absence did not supply one either. The diagnostic is
    // the host stderr for this call.
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      diagnosticEquals: hostStderr,
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.notEqual(terminal.roleOutcome.decisiveFacts.errorName, "MissingProviderCredential");
      assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
      assert.ok(terminal.roleOutcome.diagnostic.length > 0);
    }
    const errorBody = terminalBodyAt(errorRef!.path, "error") as {
      cause: string;
      identity?: { name?: string; code?: string | number };
      diagnostic: string;
    };
    // A bare nonzero exit names no cause; what matters here is that credential
    // absence did not relabel it either.
    assert.equal(errorBody.cause, undefined);
    assert.equal(errorBody.diagnostic, hostStderr);
    assert.notEqual(errorBody.identity?.name, "MissingProviderCredential");
    assert.ok(stderr[0]!.length > 0);
  });
});

test("public entry keeps host details beside package facts and a timeout beside a typed cause", async () => {
  async function runHost(
    runId: string,
    prompt: string,
    piRunner: (args: readonly string[]) => Promise<{
      code: number | null;
      stderr: string;
      timedOut: boolean;
      args: string[];
      knownFailure?: {
        cause?: "provider";
        diagnostic?: string;
        identity?: { name?: string; code?: string | number };
        details?: Record<string, unknown>;
      };
    }>,
    check: (settled: {
      result: Awaited<ReturnType<typeof runAkRole>>;
      stdout: string[];
      stderr: string[];
    }) => Promise<void>,
  ) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["judge", "--model", "test/caller-seat:high", "--project", project, prompt],
        {
          packageRoot,
          home,
          cwd: project,
          createRunId: () => runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
              const sessionDir = args[args.indexOf("--session-dir") + 1]!;
              await mkdir(sessionDir, { recursive: true });
              await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
              return piRunner(args);
            },
          }),
        },
      );
      await check({ result, stdout, stderr });
    });
  }

  const hostDetails = { code: 99, timedOut: true, exitCode: 7, provider: "xai" };
  await runHost(
    "run-host-details-keys-001",
    "host details keys",
    async (args) => ({
      code: 1,
      stderr: "",
      timedOut: false,
      args: [...args],
      knownFailure: {
        cause: "provider",
        diagnostic: "upstream unavailable",
        identity: { name: "ProviderUnavailableError", code: "PROVIDER_UNAVAILABLE" },
        details: hostDetails,
      },
    }),
    async ({ result, stdout, stderr }) => {
      const { errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "provider",
        diagnosticEquals: "upstream unavailable",
        identityName: "ProviderUnavailableError",
        identityCode: "PROVIDER_UNAVAILABLE",
      });
      const errorBody = terminalBodyAt(errorRef!.path, "error") as {
        details?: { code?: unknown; timedOut?: unknown; exitCode?: unknown; provider?: unknown };
        packageFact?: { exitCode?: number | null; timedOut?: boolean };
      };
      assert.deepEqual(errorBody.details, hostDetails);
      assert.equal(errorBody.packageFact?.exitCode, 1);
      assert.equal(errorBody.packageFact?.timedOut, undefined);
    },
  );

  await runHost(
    "run-timeout-beside-provider-001",
    "timeout beside provider",
    async (args) => ({
      code: null,
      stderr: "HOST STDERR MUST STAY OFF THE DIAGNOSTIC\n",
      timedOut: true,
      args: [...args],
      knownFailure: {
        cause: "provider",
        diagnostic: "rate limited",
        identity: { name: "ProviderStopError", code: "openai-codex" },
      },
    }),
    async ({ result, stdout, stderr }) => {
      const { errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "provider",
        diagnosticEquals: "rate limited",
        identityName: "ProviderStopError",
        identityCode: "openai-codex",
      });
      const errorBody = terminalBodyAt(errorRef!.path, "error") as {
        details?: unknown;
        packageFact?: { exitCode?: number | null; timedOut?: boolean };
      };
      assert.equal(errorBody.details, undefined);
      assert.equal(errorBody.packageFact?.exitCode, null);
      assert.equal(errorBody.packageFact?.timedOut, true);
    },
  );

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
    const errorBody = terminalBodyAt(errorRef!.path, "error") as {
      cause: string;
      identity?: { name?: string; code?: string | number };
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.identity?.name, "MissingProviderCredential");
    assert.equal(errorBody.identity?.code, "xai");
    assert.ok(stderr[0]!.length > 0);
  });
});
test("a sealed receipt stays recorded when the host CLI reported a nonzero exit", async () => {
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
              details: { status: "converged", ticketNumber: 1171},
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
                details: { status: "converged", ticketNumber: 1171},
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
              details: { status: "converged", ticketNumber: 1171},
            },
          };
        },
        }),
      },
    );
    // The host CLI reported a nonzero exit for this call, so the turn fails on
    // that report even though a submission was sealed. The sealed receipt is not
    // lost: it stays on the run-scoped submissions (owner 4743ade7).
    assert.equal(result.exitCode, 1);
    assert.equal(stderr.length, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(result.terminal!.roleOutcome.cause, undefined);
    }
    assert.deepEqual(
      (result.terminal!.submissions ?? []).map((row) => JSON.stringify(row)),
      [`{"status":"converged","ticketNumber":1171}`],
      "the sealed receipt stays recorded on the run-scoped carrier",
    );
  });
});
