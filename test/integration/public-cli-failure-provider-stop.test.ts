import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixtureJudgeAdmitted } from "../helpers/admitted-principal-fixture.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
// #107 session provider-stop 绑定与 #307 typed HTTP 观察家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { knownFailureFromProviderStop } from "../../src/pi/known-failure.ts";
import { classifyPostAdmissionFailure, extractSessionProviderStop, resolveAuditedRunnerFailureResolution, settleFailureTerminalResult } from "../../src/public-cli/settlement.ts";
import { readLatestTypedProviderHttpObservation } from "../../src/public-cli/run-lifecycle.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import {
  packageRoot,
} from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
} from "../helpers/failure-settlement-kit.ts";

test("fast audited-seat public wiring matrix settles an injected auditor provider stop", async () => {
  // #495 S6: AUDITOR_SOUL_ROLES is judge/doctor only (reviewer gate retired; fixer #242).
  const argv = {
    judge: (project: string) => ["--model", "openai-codex/faux-1:off", "judge", "--project", project, "audit provider stop"],
    doctor: (project: string) => ["--model", "openai-codex/faux-1:off", "doctor", "--issue", "212", "--project", project, "audit provider stop"],
  } as const;
  for (const role of AUDITOR_SOUL_ROLES) await withTempHome(async (home) => {
    const project = join(home, `proj-${role}`);
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runDirectory = join(project, "run");
    await mkdir(runDirectory, { recursive: true });
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(argv[role](project), {
      packageRoot, home, cwd: project, io,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => `run-${role}-auditor-provider-stop`,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        const sessionFile = join(sessionDir, "session.jsonl");
        // #675: compliance is public auditor summon — inject the bound provider-stop
        // fact the settlement layer reads (no retired institutional audit options).
        // #675: the host CLI itself reports the provider stop for this call —
        // exit code plus its own typed failure. The package presents that as
        // given; it does not read a retained stop back to decide the cause.
        await writeFile(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "aborted" } })}\n`);
        return {
          code: 1,
          stderr: "[ak-patch] normal activation banner\n",
          timedOut: false,
          args: [...args],
          knownFailure: {
            cause: "provider" as const,
            diagnostic: "WebSocket error",
            identity: { name: "faux-1", code: "openai-codex" },
          },
        };
      },
          }),
    });
    // The cause is the host CLI's own report for this call, presented as given.
    const { terminal } = await assertPublicFailureSettlement({
      result, stdout, stderr, expectedCause: "provider",
    });
    assert.equal(terminal.roleOutcome.kind, "failure", `${role}: no Receipt outcome`);
  });
});
test("runnerFailure registry rank is the public settlement principal", async () => {
  const detourDiagnostic = "ENGINE_DETOUR_HARD_FAIL_505_RECORD";
  const knownDiagnostic = "KNOWN_FAILURE_505_STANDS";
  const cases = [
    {
      label: "judge: a lone engine-detour record supplies the cause when the host reported none",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "judge", "--project", project, "rank"],
      session: "detour" as const,
      known: false,
      cause: "output" as const,
      diagnostic: detourDiagnostic,
    },
    {
      // The host's own report for this call stands; a session record does not
      // replace it (owner 4743ade7: 代码凭什么要去决定cli的失败原因？).
      label: "reviewer: the host report is not replaced by an engine-detour record",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "reviewer", "--project", project, "--base", "HEAD", "--lens", "correctness", "--authority-ref", "CLAUDE.md"],
      session: "detour" as const,
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "gatekeeper: same rule as every other runner-failure seat",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "gatekeeper", "--project", project, "rank"],
      session: "detour" as const,
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "collector has no runnerFailure leaf so knownFailure stands",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "collector", "--project", project, "--pr", "7", "--repo", "acme/widgets"],
      session: "detour" as const,
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "gleaner-left has no runnerFailure leaf so knownFailure stands",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "gleaner-left", "--project", project, "--base", "HEAD", "rank"],
      session: "detour" as const,
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
  ];
  for (const [index, row] of cases.entries()) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const toolName = ENGINE_DETOUR_TOOL_NAME;
      const toolText = detourDiagnostic;
      const result = await runAkRole(row.argv(project), {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => `run-505-rank-${index}`,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            const sessionIndex = args.indexOf("--session");
            const sessionFile = args[sessionIndex + 1];
            if (sessionIndex === -1 || sessionFile === undefined) {
              throw new Error(`${row.label}: runner args have no --session`);
            }
            await mkdir(dirname(sessionFile), { recursive: true });
            await writeFile(sessionFile, [
              JSON.stringify({ type: "session", id: "parent-session" }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  content: [{ type: "toolCall", id: "infra-505", name: toolName, arguments: {} }],
                  stopReason: "toolUse",
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "infra-505",
                  toolName,
                  isError: true,
                  content: [{ type: "text", text: toolText }],
                },
              }),
            ].join("\n") + "\n", "utf8");
            return {
              code: 1,
              stderr: "rank\n",
              timedOut: false,
              args: [...args],
              ...(row.known
                ? {
                  knownFailure: {
                    cause: "provider" as const,
                    diagnostic: knownDiagnostic,
                    identity: { name: "SecondaryProviderStop" },
                  },
                }
                : {}),
            };
          },
        }),
      });
      const { terminal } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: row.cause,
        diagnosticEquals: row.diagnostic,
      });
      assert.equal(terminal.roleOutcome.kind, "failure", row.label);
    });
  }
});

test("#380: soft engine-detour failure is not infrastructure and does not outrank knownFailure", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const detourDiagnostic = "ENGINE_DETOUR_SOFT_FAIL_380_NOT_INFRA";
    const secondaryDiagnostic = "SECONDARY_KNOWN_FAILURE_WINS_WHEN_DETOUR_SOFT_380";
    const result = await runAkRole(
      [
        "--model",
        "openai-codex/gpt-5.6-sol:medium",
        "reviewer",
        "--project",
        project,
        "--base",
        "HEAD",
        "--lens",
        "correctness",
        "--authority-ref",
        "CLAUDE.md",
        "--engine",
        "kimi",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-reviewer-detour-soft-380-001",
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            [
              JSON.stringify({ type: "session", id: "parent-session" }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "engine-detour-parent",
                      name: ENGINE_DETOUR_TOOL_NAME,
                      arguments: { argv: ["kimi"] },
                    },
                  ],
                  stopReason: "toolUse",
                },
              }),
              // #380 soft-fail shape: detourFailed details, isError false — not infrastructure.
              JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "engine-detour-parent",
                  toolName: ENGINE_DETOUR_TOOL_NAME,
                  isError: false,
                  content: [{ type: "text", text: `Engine detour failed: ${detourDiagnostic}` }],
                  details: {
                    tool: ENGINE_DETOUR_TOOL_NAME,
                    detourFailed: true,
                  },
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: secondaryDiagnostic,
                  provider: "openai-codex",
                  model: "gpt-5.6-sol",
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
          return {
            code: 1,
            stderr: `Extension error: ${secondaryDiagnostic}\n`,
            timedOut: false,
            args: [...args],
            knownFailure: {
              cause: "provider",
              diagnostic: secondaryDiagnostic,
              identity: { name: "SecondaryProviderStop" },
            },
          };
        },
          }),
      },
    );
    // Soft detour is not infra; later knownFailure remains the settlement principal.
    const { terminal, errorRef } = await assertPublicFailureSettlement({
      result,
      stdout,
      stderr,
      expectedCause: "provider",
      diagnosticEquals: secondaryDiagnostic,
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    if (terminal.roleOutcome.kind === "failure") {
      assert.equal(terminal.roleOutcome.cause, "provider");
      assert.equal(terminal.roleOutcome.diagnostic, secondaryDiagnostic);
    }
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause: string;
      diagnostic: string;
    };
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.diagnostic, secondaryDiagnostic);
  });
});
test("a malformed current session keeps its real read failure", async () => {
  await withTempHome(async (home) => {
    const sessionDir = join(home, "session");
    const sessionFile = join(sessionDir, "parent.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "{malformed\n");
    // The session this call reads is unreadable now, so the read failure is
    // this turn's own fact and keeps its identity.
    const malformed = (await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile,
      credential: undefined,
    })).knownFailure;
    assert.equal(malformed?.cause, "session");
    assert.equal(malformed?.identity?.name, "SyntaxError");
  });
});

test("an unreadable session keeps its real cause beside a credential fact", async () => {
  await withTempHome(async (home) => {
    const pathComponent = join(home, "not-a-directory");
    await writeFile(pathComponent, "file");
    // The caller-declared credential failure is this invocation's own fact and
    // is not displaced; the ENOTDIR it would have cost stays on the record.
    const failure = (await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile: join(pathComponent, "parent.jsonl"),
      credential: { cause: "activation", diagnostic: "credential fallback" },
    })).knownFailure;
    assert.equal(failure?.cause, "activation");
    assert.equal(failure?.diagnostic, "credential fallback");
  });
});

test("an unreadable session with no reported fact keeps its real read failure", async () => {
  await withTempHome(async (home) => {
    const pathComponent = join(home, "not-a-directory-2");
    await writeFile(pathComponent, "file");
    const failure = (await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile: join(pathComponent, "parent.jsonl"),
      credential: undefined,
    })).knownFailure;
    assert.equal(failure?.cause, "session");
    assert.deepEqual(failure?.identity, { name: "Error", code: "ENOTDIR" });
    assert.ok(failure?.diagnostic);
  });
});
test("typed output failure cannot bind a call from an earlier attempt", async () => {
  await withTempHome(async (home) => {
    const sessionFile = join(home, "session.jsonl");
    await writeFile(sessionFile, [
      { type: "session", id: "parent-session" },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "reused-id", name: "ak_judge_output", arguments: {} }] } },
      { type: "message", message: { role: "user" } },
      { type: "message", message: {
        role: "toolResult",
        toolCallId: "reused-id",
        toolName: "ak_judge_output",
        isError: true,
        content: [{ type: "text", text: "unbound current-attempt result" }],
        details: { kind: "role_infrastructure_failure", source: "shared-role-lifecycle", reasonCode: "host_failure" },
      } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const noFailure = await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile,
      credential: undefined,
    });
    assert.equal(noFailure.knownFailure, undefined);
  });
});
// Session provider-stop causal matrix (#420 整改并一)：三条同根「session stop
// 因果穿越退出码形态」——code=1 / code=0 / timedOut——收成一条三行表。
test("session provider-stop retains typed identity across exit-code shapes", async () => {
  const sessionRows = (errorMessage: string): string =>
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
          errorMessage,
          provider: "xai",
          model: "grok-4",
          api: "openai-responses",
        },
      }),
    ].join("\n") + "\n";
  const rows = [
    {
      label: "nonzero exit keeps session-stop cause without injected knownFailure",
      runId: "run-session-provider-stop-001",
      errorMessage: "WebSocket error",
      child: { code: 1 as const, stderr: "activation wrapper exited nonzero\n", timedOut: false as const },
    },
    {
      label: "zero-exit still reads session provider-stop (not washed to output)",
      runId: "run-zero-exit-session-provider-stop-001",
      errorMessage: "upstream websocket failed",
      child: { code: 0 as const, stderr: "", timedOut: false as const },
    },
    {
      label: "timedOut co-present keeps session provider identity (AC2)",
      runId: "run-timeout-provider-stop-001",
      errorMessage: "provider hung then killed",
      child: { code: null as unknown as number, stderr: "still running\n", timedOut: true as const },
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["--model", "xai/grok-4:off", "judge", "--project", project, `session provider stop: ${row.label}`],
        {
          packageRoot,
          home,
          cwd: project,
          credentials: { "openai-codex": true, xai: true },
          createRunId: () => row.runId,
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            await mkdir(sessionDir, { recursive: true });
            await writeFile(join(sessionDir, "session.jsonl"), sessionRows(row.errorMessage), "utf8");
            return {
              ...row.child,
              args: [...args],
              // deliberately omit knownFailure — production default runner path
            };
          },
          }),
        },
      );
      const { terminal, errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        diagnosticEquals: row.errorMessage,
      });
      assert.equal(terminal.roleOutcome.kind, "failure", row.label);
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.cause, undefined, row.label);
        assert.equal(terminal.roleOutcome.decisiveFacts.errorName, undefined, row.label);
        assert.equal(terminal.roleOutcome.decisiveFacts.errorCode, undefined, row.label);
        assert.equal(terminal.roleOutcome.diagnostic, row.errorMessage, row.label);
      }
      const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
        cause: string;
        diagnostic: string;
        identity?: { name?: string; code?: string | number };
        details?: { timedOut?: boolean; errorMessage?: string };
      };
      assert.equal(errorBody.cause, undefined, row.label);
      assert.equal(errorBody.diagnostic, row.errorMessage, row.label);
      assert.equal(errorBody.identity, undefined, row.label);
      assert.equal(errorBody.details?.errorMessage, row.errorMessage, row.label);
      if (row.child.timedOut) {
        // AC2: timeout must not wash the co-present provider-stop identity.
        assert.equal(errorBody.details?.timedOut, true, row.label);
      }
    });
  }

  // Typed seam unit: stopReason error without upstream testimony is unknown; other stops ignored.
  const fromStop = knownFailureFromProviderStop({
    stopReason: "error",
    errorMessage: "WebSocket error",
    provider: "xai",
  });
  assert.equal(fromStop?.cause, undefined);
  assert.equal(fromStop?.identity, undefined);
  assert.equal(fromStop?.diagnostic, "WebSocket error");
  assert.deepEqual(
    fromStop?.details,
    { errorMessage: "WebSocket error" },
  );
  // Prose "500:" alone is not testimony (kept once here; no duplicate helper block).
  assert.equal(
    knownFailureFromProviderStop({
      stopReason: "error",
      errorMessage: "500: Internal error during token generation",
      provider: "openai-codex",
    })?.cause,
    undefined,
  );
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


test("#307 2xx clears prior typed HTTP observation rather than persisting success", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "http-2xx-clear-"));
  try {
    // Single shortest real tracer: production after_provider_response only.
    await observeTyped429ViaProductionHandler({
      runDirectory: runDir,
      provider: "openai-codex",
      httpStatus: 500,
    });
    assert.deepEqual(await readLatestTypedProviderHttpObservation(runDir), {
      httpStatus: 500,
      provider: "openai-codex",
    });
    await observeTyped429ViaProductionHandler({
      runDirectory: runDir,
      provider: "openai-codex",
      httpStatus: 200,
    });
    assert.equal(await readLatestTypedProviderHttpObservation(runDir), undefined);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
test("#307 typed HTTP observation: ENOENT is absence; non-absence failures keep real cause", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj-typed-http-read");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-typed-http-read-001";
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`);
    await mkdir(runDirectory, { recursive: true });
    const sessionFile = join(runDirectory, "session", "missing-session.jsonl");

    // Absence (no sidecar): ENOENT → undefined observation, no forged failure.
    assert.equal(await readLatestTypedProviderHttpObservation(runDirectory), undefined);
    const absent = await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.equal(absent.knownFailure, undefined);

    // Non-absence: existing sidecar with illegal typed shape keeps real cause on settlement chain.
    await writeFile(join(runDirectory, "typed-provider-http.json"), JSON.stringify({ httpStatus: 500 }), "utf8");
    const badShape = (await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    })).knownFailure;
    assert.equal(badShape?.cause, "session");
    assert.equal(badShape?.identity?.name, "Error");

    // Non-absence: malformed JSON keeps SyntaxError identity (not laundered as absence).
    await writeFile(join(runDirectory, "typed-provider-http.json"), "{not-json\n", "utf8");
    const malformed = (await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    })).knownFailure;
    assert.equal(malformed?.cause, "session");
    assert.equal(malformed?.identity?.name, "SyntaxError");

    // Non-absence: EISDIR on the observation path keeps real errno cause.
    await rm(join(runDirectory, "typed-provider-http.json"), { force: true });
    await mkdir(join(runDirectory, "typed-provider-http.json"));
    const eisdir = (await resolveAuditedRunnerFailureResolution({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    })).knownFailure;
    assert.equal(eisdir?.cause, "session");
    assert.equal(eisdir?.identity?.code, "EISDIR");
  });
});
test("#307 typed HTTP non-absence failure retains the final dispatch error after resume budget", async () => {
  // EISDIR on the typed-HTTP sidecar must reach the controlled-failure error.json;
  // later resume attempts may fail independently before the host turn.
  await withTempHome(async (home) => {
    const project = join(home, "proj-typed-http-resume-once");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-typed-http-resume-once-001";
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(["judge", "--model", "test/caller-seat:high", "--project", project, "typed http sidecar is a directory"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot: packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          await mkdir(sessionDir, { recursive: true });
          // Sidecar path occupied as a directory → readFile EISDIR (non-absence).
          await mkdir(join(runDir, "typed-provider-http.json"), { recursive: true });
          return {
            code: 1,
            stderr: "provider child exited",
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
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(result.terminal!.autoResumeCount, 2);
      assert.ok(result.terminal!.roleOutcome.decisiveFacts.errorCode);
    }
    // The first controlled failure remains on disk even when the final terminal
    // reports a later pre-turn error.
    const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
    assert.ok(errorRef, "controlled failure must publish error artifact");
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as Record<string, unknown>;
    assert.equal(errorBody.attempt, 1);
    const firstError = JSON.parse(await readFile(join(dirname(errorRef.path), "error.json"), "utf8")) as {
      cause?: string;
      identity?: { code?: string };
    };
    assert.equal(firstError.cause, "session");
    assert.equal(firstError.identity?.code, "EISDIR");
  });
});
/**
 * SessionManager defers first durable write until an assistant message exists.
 * After production Sitian retain, append realistic parent-aborted framing so the
 * parent session principal exists on disk. Does not invent the evidence stop —
 * readSessionProviderStop prefers Sitian retained auditor response over this framing.
 */
function flushRetainedParentSession(sessionManager: SessionManager): void {
  sessionManager.appendMessage({
    role: "assistant",
    content: [],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    timestamp: Date.now(),
  });
}

/** Settle a disk session stop through the production knownFailure→error.json chain. */
async function settleDiskSessionStopToErrorJson(input: {
  home: string;
  project: string;
  runId: string;
  sessionFile: string;
  sessionDirectory: string;
  exitCode?: number;
}): Promise<{ errorPath: string; errorBody: Record<string, unknown> }> {
  const bookKey = resolveBookKeyFromGit(input.project);
  const runDirectory = join(
    input.home,
    ".ak-roles",
    "books",
    bookKey,
    "runs",
    `${input.runId}@judge`,
  );
  await mkdir(join(runDirectory, "artifacts"), { recursive: true });
  const known = (await resolveAuditedRunnerFailureResolution({
    runner: undefined,
    sessionFile: input.sessionFile,
    credential: undefined,
    runDirectory,
  })).knownFailure;
  assert.ok(known, "disk session must yield a failure");
  const failure = classifyPostAdmissionFailure({
    timedOut: false,
    code: input.exitCode ?? 1,
    stderr: "",
    ...(known.cause === undefined ? {} : { knownCause: known.cause }),
    ...(known.diagnostic === undefined ? {} : { knownDiagnostic: known.diagnostic }),
    ...(known.identity === undefined ? {} : { knownIdentity: known.identity }),
    ...(known.details === undefined ? {} : { knownDetails: known.details }),
  });
  const admitted = fixtureJudgeAdmitted({
    runId: input.runId,
    bookKey,
    projectRoot: input.project,
    instruction: "x",
    instructionEmpty: false,
    runDirectory,
    sessionDirectory: input.sessionDirectory,
    sessionFile: input.sessionFile,
  });
  await writeFile(admitted.admittedRequestPath, "{}\n", "utf8");
  const terminal = await settleFailureTerminalResult(admitted, failure, piDurablePrincipalAuthority);
  const errorRef = terminal.artifacts.find((a) => a.kind === "error");
  assert.ok(errorRef, "settlement must publish error artifact");
  const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as Record<string, unknown>;
  return { errorPath: errorRef.path, errorBody };
}