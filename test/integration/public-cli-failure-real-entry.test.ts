// #107/#373 public-CLI acceptance tracer — 公开入口因果身份家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDIT_ESCALATION_KIND, buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { ExplicitInternalActivationError } from "../../src/host-contracts.ts";
import { CONCISE_DIAGNOSTIC_MAX_CHARS, exitCodeForTerminalOutcome, formatFailureStderrDiagnostic, isLawfulTypedTerminalOutcome } from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";
import { recordAuditEscalationSubmission } from "../helpers/submission-ledger-fixture.ts";
import { seedDoctorIssueRuns } from "../helpers/doctor-fixtures.ts";

test("public CLI multi-turn audit escalate covers audited seats", async () => {
  // #495 S6: reviewer-side auditor retired — seats follow AUDITOR_SOUL_ROLES (judge/doctor).
  const seats = {
    judge: {
      output: JUDGE_OUTPUT_TOOL_NAME,
      audit: JUDGE_AUDIT_TOOL_NAME,
      argv: (project: string) => ["judge", "--project", project, "multi-turn audit escalate"],
    },
    doctor: {
      output: DOCTOR_OUTPUT_TOOL_NAME,
      audit: DOCTOR_AUDIT_TOOL_NAME,
      argv: (project: string) => [
        "doctor",
        "--issue",
        "373",
        "--project",
        project,
        "multi-turn audit escalate",
      ],
    },
  } as const;

  const auditCandidate = {
    status: "escalate" as const,
    conflicts: ["authority conflict"],
    decisionGate: { question: "Who decides?", options: ["owner", "caller"] },
  };

  /** One shared withTempHome/project/run/piRunner/session write for all scenes. */
  async function runMultiTurnPublicCliScene<
    T,
  >(scene: {
    label: string;
    role: (typeof AUDITOR_SOUL_ROLES)[number];
    argv: (project: string) => string[];
    roleCallArguments: unknown;
    auditArguments: unknown;
    toolResult: { isError: boolean; details: unknown };
    trailingSessionEntries?: readonly unknown[];
  }, observe: (ctx: {
    result: { exitCode: number; terminal?: TerminalResult };
    stdout: string[];
    stderr: string[];
  }) => Promise<T>): Promise<T> {
    return withTempHome(async (home) => {
      const project = join(home, `proj-${scene.label}`);
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      if (scene.role === "doctor") {
        await seedDoctorIssueRuns(home, resolveBookKeyFromGit(project), 373);
      }
      const runId = `run-${scene.label}`;
      const roleCallId = `${scene.label}-call`;
      const seat = seats[scene.role];
      const { io, stdout, stderr } = captureIo();
      const result = await runAkRole(scene.argv(project), {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await mkdir(dirname(sessionFile), { recursive: true });
          const entries = [
            {
              type: "message",
              message: {
                role: "assistant",
                content: [{
                  type: "toolCall",
                  id: roleCallId,
                  name: seat.output,
                  arguments: scene.roleCallArguments,
                }],
              },
            },
            ...multiTurnIntermediateRetained(runId),
            {
              type: "custom",
              customType: "ak_compliance_response",
              data: {
                version: 1,
                response: {
                  content: [{
                    type: "toolCall",
                    name: seat.audit,
                    arguments: scene.auditArguments,
                  }],
                },
              },
            },
            {
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: roleCallId,
                toolName: seat.output,
                isError: scene.toolResult.isError,
                details: scene.toolResult.details,
              },
            },
            ...(scene.trailingSessionEntries ?? []),
          ];
          await writeFile(
            sessionFile,
            `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
            "utf8",
          );
          // Live audit-escalation must be ledger-recorded (settlement no longer rebuilds from JSONL).
          if (
            scene.toolResult.isError === false &&
            scene.toolResult.details !== null &&
            typeof scene.toolResult.details === "object" &&
            (scene.toolResult.details as { kind?: unknown }).kind === AUDIT_ESCALATION_KIND
          ) {
            const runDirectory = join(dirname(sessionFile), "..");
            await recordAuditEscalationSubmission({
              cwd: project,
              runId,
              role: scene.role,
              details: scene.toolResult.details,
              home,
              runDirectory,
              toolCallId: roleCallId,
            });
          }
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
        }),
      });
      return observe({ result, stdout, stderr });
    });
  }

  // (a) Audited-seat multi-turn escalate via real public CLI.
  for (const role of AUDITOR_SOUL_ROLES) {
    const seat = seats[role];
    // Keep live registry projection for ledger recognition; clone only for session bytes.
    const liveProjected = buildAuditEscalationResult(
      {
        status: "escalate",
        conflicts: auditCandidate.conflicts,
        decisionGate: auditCandidate.decisionGate,
      },
      { role },
    );
    const projected = JSON.parse(JSON.stringify(liveProjected));
    await runMultiTurnPublicCliScene({
      label: `${role}-escalate`,
      role,
      argv: seat.argv,
      roleCallArguments: { role },
      auditArguments: auditCandidate,
      toolResult: { isError: false, details: liveProjected },
    }, async ({ result, stdout, stderr }) => {
      assert.equal(result.exitCode, 0, `${role}: ${stderr.join("") || stdout.join("") || "nonzero"}`);
      assert.ok(result.terminal, `${role}: public CLI must settle a Terminal`);
      const escalateOutcome = result.terminal!.roleOutcome;
      const escalateKind: string = escalateOutcome.kind;
      const escalateStatus =
        "status" in escalateOutcome ? String(escalateOutcome.status) : undefined;
      assert.equal(escalateKind, "audit_escalation", role);
      assert.equal(escalateOutcome.role, role);
      assert.equal(escalateStatus, "audit_escalation", role);
      assert.equal(isLawfulTypedTerminalOutcome(escalateOutcome), true, role);
      assert.equal(exitCodeForTerminalOutcome(escalateOutcome), 0, role);
      // Escalate is typed-distinct from accepted receipt / completed / refused.
      assert.notEqual(escalateKind, "accepted", role);
      assert.notEqual(escalateStatus, "completed", role);
      assert.notEqual(escalateStatus, "refused", role);
      assert.equal(
        (escalateOutcome as { acceptedReceipt?: unknown }).acceptedReceipt,
        undefined,
        `${role}: escalate must not set acceptedReceipt true`,
      );
      assert.equal(
        escalateOutcome.decisiveFacts.kind,
        AUDIT_ESCALATION_KIND,
        role,
      );
      // Not cause=output error.json — report artifact is the escalate face.
      assert.equal(result.terminal!.artifacts.some((a) => a.kind === "error"), false, role);
      assert.ok(result.terminal!.artifacts.some((a) => a.kind === "report"), role);
      const reportPath = result.terminal!.artifacts.find((a) => a.kind === "report")!.path;
      const reportBody = JSON.parse(await readFile(reportPath, "utf8")) as {
        role?: string;
        outcome?: { kind?: string; status?: string };
        receipt?: { status?: string };
      };
      assert.equal(reportBody.role, role);
      assert.equal(reportBody.outcome?.kind, "audit_escalation", role);
      assert.equal(reportBody.outcome?.status, "audit_escalation", role);
      // Escalate report is not an accepted role receipt (completed/refused).
      assert.notEqual(reportBody.receipt?.status, "completed", role);
      assert.notEqual(reportBody.receipt?.status, "refused", role);
    });
  }
});
// Publication errno matrix: lawful session, then publication fails on a hostile
// destination — the errno identity must survive, never washed into output absence.
test("public report publication failures retain typed errno identity", async () => {
  // EISDIR: report.json occupied as a directory. Audit-incomplete publication
  // path was abolished (#475); error-artifact publication stays on failure channel.
  const rows = [
    {
      label: "EISDIR on report publication",
      // Converged session is lawful; report.json as a directory makes writeFile EISDIR.
      plant: async (runDir: string) => {
        await mkdir(join(runDir, "artifacts", "report.json"), { recursive: true });
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
              details: { judgeStatus: "converged" },
            },
          })}\n`,
          "utf8",
        );
      },
      expectedCode: "EISDIR",
    },
  ] as const;
  for (const row of rows) {
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
          createRunId: () => "run-audit-artifact-errno-001",
          io,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args) => {
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            const runDir = join(sessionDir, "..");
            await row.plant(runDir);
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
                details: { judgeStatus: "converged" },
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
      assert.equal(outcome.cause, "unrecognized", row.label);
      assert.notEqual(outcome.cause, "output", row.label);
      assert.equal(outcome.decisiveFacts.errorCode, row.expectedCode, row.label);
      const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
      assert.ok(errorRef, row.label);
      const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
        cause: string;
        identity?: { name?: string; code?: string | number };
        diagnostic: string;
      };
      assert.equal(errorBody.cause, "unrecognized", row.label);
      assert.equal(errorBody.identity?.code, "EISDIR", row.label);
      assert.ok(errorBody.diagnostic.length > 0, row.label);
    });
  }
});
// Post-admission child failure matrix: admission succeeded, the pi child exits
// zero without a lawful terminal — one shared shape, three classified causes.
test("zero-exit post-admission failures classify typed causes via public entry", async () => {
  const rows = [
    {
      label: "missing session → cause=session",
      argv: (project: string) => ["judge", "--project", project, "no session bytes"],
      runId: "run-session-missing-001",
      seedSession: async (_sessionFile: string) => {
        // Admitted session directory exists but holds no transcript.
      },
      expectedCause: "session" as const,
      expectedRole: undefined,
    },
    {
      label: "invalid coder details → coder identity fallback",
      argv: (project: string) => ["coder", "apply", "--project", project, "bogus details"],
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
      expectedCause: "output" as const,
      expectedRole: "coder" as const,
    },
    {
      label: "invalid judge details → cause=output",
      argv: (project: string) => ["judge", "--project", project, "bogus details"],
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
              details: { judgeStatus: "bogus" },
            },
          })}\n`,
          "utf8",
        );
      },
      expectedCause: "output" as const,
      expectedRole: undefined,
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
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
      await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: row.expectedCause,
      });
      if (row.expectedRole !== undefined) {
        assert.equal(result.terminal?.roleOutcome.role, row.expectedRole, row.label);
        const errorRef = result.terminal?.artifacts.find((artifact) => artifact.kind === "error");
        assert.ok(errorRef, row.label);
        const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as { role: string };
        assert.equal(errorBody.role, row.expectedRole, row.label);
      }
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
    const result = await runAkRole(
      ["judge", "--project", project, "provider down"],
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
    const result = await runAkRole(
      ["judge", "--project", project, "provider throw"],
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
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
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
            stderr: "late host noise\n",
            timedOut: false,
            args: [...args],
            sealedAcceptance: {
              role: "judge" as const,
              details: { judgeStatus: "converged" },
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
    assert.equal(result.terminal!.roleOutcome.status, "converged");
    assert.equal(result.terminal!.runId, "run-prefer-lawful-001");
  });
});
