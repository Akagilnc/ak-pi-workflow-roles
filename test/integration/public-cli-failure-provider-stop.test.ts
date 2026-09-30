import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
// #107 session provider-stop 绑定与 #307 typed HTTP 观察家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { resolveAuditedRunnerFailureResolution } from "../../src/public-cli/settlement.ts";
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
// Per seat, with a full engine-detour transcript left behind either way: the
// host's own report for this call is what the terminal presents. A record in
// the transcript never supplies a cause and never replaces one (owner 4743ade7:
// 代码凭什么要去决定cli的失败原因？). Every seat is asserted on the same rule —
// there is no seat whose failure this package attributes any other way.
test("every seat presents the host's own report; a transcript record never decides it", async () => {
  const detourDiagnostic = "ENGINE_DETOUR_HARD_FAIL_505_RECORD";
  const knownDiagnostic = "KNOWN_FAILURE_505_STANDS";
  const cases = [
    {
      // The host reported a bare nonzero exit and nothing else. The
      // engine-detour record in the transcript is history: it does not become
      // this call's cause, and no cause is invented for it (#881).
      label: "judge: a lone engine-detour record supplies nothing when the host reported none",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "judge", "--project", project, "rank"],
      known: false,
      cause: undefined,
      diagnostic: undefined,
    },
    {
      label: "reviewer: the host report is not replaced by an engine-detour record",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "reviewer", "--project", project, "--base", "HEAD", "--lens", "correctness", "--authority-ref", "CLAUDE.md"],
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "gatekeeper: the host report stands",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "gatekeeper", "--project", project, "rank"],
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "navigator: the host report stands",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "navigator", "--project", project, "rank"],
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "collector: the host report stands",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "collector", "--project", project, "--pr", "7", "--repo", "acme/widgets"],
      known: true,
      cause: "provider" as const,
      diagnostic: knownDiagnostic,
    },
    {
      label: "gleaner-left: the host report stands",
      argv: (project: string) => ["--model", "openai-codex/faux-1:off", "gleaner-left", "--project", project, "--base", "HEAD", "rank"],
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
        createRunId: () => `run-host-report-${index}`,
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
        ...(row.cause === undefined ? {} : { expectedCause: row.cause }),
        ...(row.diagnostic === undefined ? {} : { diagnosticEquals: row.diagnostic }),
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
// A turn's cause is what the host CLI reported for that call. The transcript
// it left behind does not decide anything: a provider-stop written into the
// session is neither promoted into the failure's identity nor required to
// explain it (owner ea321c6d: 不是本轮cli报告的什么就是什么吗？).
test("a provider stop left in the transcript never becomes this turn's cause", async () => {
  const rows = [
    { label: "nonzero exit", runId: "run-session-stop-not-a-cause-001", code: 1 as const, stderr: "activation wrapper exited nonzero\n", timedOut: false as const },
    { label: "zero exit, no receipt", runId: "run-session-stop-zero-exit-001", code: 0 as const, stderr: "", timedOut: false as const },
    { label: "timed out", runId: "run-session-stop-timeout-001", code: null as unknown as number, stderr: "still running\n", timedOut: true as const },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(
        ["--model", "xai/grok-4:off", "judge", "--project", project, `transcript stop: ${row.label}`],
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
              await writeFile(join(sessionDir, "session.jsonl"), [
                JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
                JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "TRANSCRIPT PROVIDER STOP", provider: "xai", model: "grok-4" } }),
              ].join("\n") + "\n", "utf8");
              // deliberately omit knownFailure — production default runner path
              return { ...row, args: [...args] };
            },
          }),
        },
      );
      // Asserted on the structured outcome below — each row states what the
      // host's own report must produce. No text search over the serialized
      // roleOutcome: a diagnostic that merely quoted the transcript would pass
      // such a check while the real cause was still wrong.
      if (row.timedOut) {
        assert.equal(result.exitCode, 1, row.label);
        assert.equal(result.terminal?.roleOutcome.kind, "failure", row.label);
        if (result.terminal?.roleOutcome.kind === "failure") {
          assert.equal(result.terminal.roleOutcome.cause, "timeout", row.label);
        }
      } else if (row.code !== 0) {
        assert.equal(result.exitCode, 1, row.label);
        assert.equal(result.terminal?.roleOutcome.kind, "failure", row.label);
        if (result.terminal?.roleOutcome.kind === "failure") {
          assert.equal(result.terminal.roleOutcome.diagnostic, row.stderr, row.label);
        }
      } else {
        // Nothing failed and nothing sealed: an honest no_receipt, not a
        // provider failure reconstructed from the transcript.
        assert.equal(result.exitCode, 0, stdout.join("") + stderr.join(""));
        assert.equal(result.terminal?.roleOutcome.kind, "no_receipt", row.label);
      }
    });
  }
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

    // A sidecar that cannot be read is a real fact, but it is this package's
    // own auxiliary observation — it never becomes the call's failure, and it
    // never edits what the host reported. Each bad sidecar is recorded whole
    // on the resolution with its real identity.
    const hostReport = { cause: "provider", diagnostic: "CURRENT_CLI_FAILURE" } as const;
    await writeFile(join(runDirectory, "typed-provider-http.json"), JSON.stringify({ httpStatus: 500 }), "utf8");
    const badShape = await resolveAuditedRunnerFailureResolution({
      runner: hostReport,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.deepEqual(badShape.knownFailure, hostReport);
    assert.equal(badShape.sidecarReadFailure?.name, "Error");

    // Malformed JSON keeps SyntaxError identity (not laundered as absence).
    await writeFile(join(runDirectory, "typed-provider-http.json"), "{not-json\n", "utf8");
    const malformed = await resolveAuditedRunnerFailureResolution({
      runner: hostReport,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.deepEqual(malformed.knownFailure, hostReport);
    assert.equal(malformed.sidecarReadFailure?.name, "SyntaxError");

    // EISDIR on the observation path keeps its real errno.
    await rm(join(runDirectory, "typed-provider-http.json"), { force: true });
    await mkdir(join(runDirectory, "typed-provider-http.json"));
    const eisdir = await resolveAuditedRunnerFailureResolution({
      runner: hostReport,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.deepEqual(eisdir.knownFailure, hostReport);
    // The errno is asserted as a structured code, not read out of the system
    // error's message wording.
    assert.equal(eisdir.sidecarReadFailure?.name, "Error");
    assert.equal(eisdir.sidecarReadFailure?.code, "EISDIR");
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
    const { io } = captureIo();
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
    // The first attempt's error.json keeps the host's own report for that call
    // (a bare nonzero exit, so no typed cause) and records the unreadable
    // sidecar as this package's own fact beside it.
    const firstError = JSON.parse(await readFile(join(dirname(errorRef.path), "error.json"), "utf8")) as {
      cause?: string;
      diagnostic?: string;
      packageFact?: { sidecarReadFailure?: { name?: string; code?: string } };
    };
    assert.equal(firstError.cause, undefined);
    // The host's own stderr survives verbatim — this is the original-report
    // fidelity contract, not a wording check.
    assert.equal(firstError.diagnostic, "provider child exited");
    assert.equal(firstError.packageFact?.sidecarReadFailure?.code, "EISDIR");
  });
});
