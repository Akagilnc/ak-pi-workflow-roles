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
import { REVIEWER_AUDIT_TOOL_NAME } from "../../src/reviewer-auditor.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { ExplicitInternalActivationError } from "../../src/public-cli/explicit-internal.ts";
import { CONCISE_DIAGNOSTIC_MAX_CHARS, exitCodeForTerminalOutcome, formatFailureStderrDiagnostic, isLawfulTypedTerminalOutcome } from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";

test("public CLI multi-turn audit escalate covers three seats; named revises stay rejected", async () => {
  const seats = {
    judge: {
      output: JUDGE_OUTPUT_TOOL_NAME,
      audit: JUDGE_AUDIT_TOOL_NAME,
      argv: (project: string) => ["judge", "--project", project, "multi-turn audit escalate"],
    },
    reviewer: {
      output: REVIEWER_OUTPUT_TOOL_NAME,
      audit: REVIEWER_AUDIT_TOOL_NAME,
      argv: (project: string) => [
        "reviewer",
        "--project",
        project,
        "--base",
        "HEAD",
        "multi-turn audit escalate",
      ],
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

  /** Typed external negative suite for a rejected revise — never pin free text. */
  async function assertRejectedReviseTerminal(input: {
    label: string;
    role: (typeof AUDITOR_SOUL_ROLES)[number];
    result: { exitCode: number; terminal?: TerminalResult };
    stdout: string[];
    stderr: string[];
  }): Promise<{ errorPath: string; evidencePath: string }> {
    const { label, role, result, stdout, stderr } = input;
    assert.equal(result.exitCode, 1, `${label}: ${stdout.join("")}`);
    assert.ok(result.terminal, `${label}: must settle typed Terminal`);
    const outcome = result.terminal!.roleOutcome;
    assert.equal(outcome.kind, "failure", label);
    assert.equal(outcome.role, role, label);
    assert.notEqual(outcome.kind, "accepted", `${label}: not accepted`);
    assert.notEqual(outcome.kind, "audit_escalation", label);
    assert.equal(
      (outcome as { status?: unknown }).status,
      undefined,
      `${label}: rejected candidate has no completed/refused status`,
    );
    assert.notEqual((outcome as { status?: unknown }).status, "completed", label);
    assert.notEqual((outcome as { status?: unknown }).status, "refused", label);
    assert.equal(
      (outcome as { acceptedReceipt?: unknown }).acceptedReceipt,
      undefined,
      `${label}: acceptedReceipt must not flip true`,
    );
    assert.equal(
      (outcome.decisiveFacts as { acceptedReceipt?: unknown }).acceptedReceipt,
      undefined,
      `${label}: decisiveFacts.acceptedReceipt must not be true`,
    );
    assert.equal(isLawfulTypedTerminalOutcome(outcome), false, label);
    assert.equal(
      result.terminal!.artifacts.some((a) => a.kind === "report"),
      false,
      `${label}: no accepted report artifact`,
    );
    const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
    const evidenceRef = result.terminal!.artifacts.find((a) => a.kind === "evidence");
    assert.ok(errorRef, `${label}: error artifact only`);
    assert.ok(evidenceRef, `${label}: evidence artifact`);
    const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
      kind?: string;
      role?: string;
      cause?: string;
      receipt?: { status?: string };
      outcome?: { kind?: string; status?: string; acceptedReceipt?: unknown };
    };
    assert.equal(errorBody.kind, "error", label);
    assert.equal(errorBody.role, role, label);
    assert.notEqual(errorBody.cause, undefined, label);
    assert.notEqual(errorBody.receipt?.status, "completed", label);
    assert.notEqual(errorBody.receipt?.status, "refused", label);
    assert.notEqual(errorBody.outcome?.kind, "accepted", label);
    assert.notEqual(errorBody.outcome?.status, "completed", label);
    assert.notEqual(errorBody.outcome?.status, "refused", label);
    assert.notEqual(errorBody.outcome?.acceptedReceipt, true, label);
    assert.equal(stderr.length, 1, `${label}: one stderr line`);
    return { errorPath: errorRef!.path, evidencePath: evidenceRef!.path };
  }

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
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
      });
      return observe({ result, stdout, stderr });
    });
  }

  // (a) Three-seat multi-turn escalate via real public CLI.
  for (const role of AUDITOR_SOUL_ROLES) {
    const seat = seats[role];
    const projected = JSON.parse(JSON.stringify(buildAuditEscalationResult(
      {
        status: "escalate",
        conflicts: auditCandidate.conflicts,
        decisionGate: auditCandidate.decisionGate,
      },
      { role },
    )));
    await runMultiTurnPublicCliScene({
      label: `${role}-escalate`,
      role,
      argv: seat.argv,
      roleCallArguments: { role },
      auditArguments: auditCandidate,
      toolResult: { isError: false, details: projected },
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

  // (d) Two named real rejection cases — once each on reviewer (authorityRefs seat).
  // Scene facts live in admitted-request + session shape; deterministic revise only
  // seals the audit decision. Never 3×2 against the escalate seats above.
  const authority516 = "https://github.com/Akagilnc/ming-salvage-sim/issues/516";
  const authority517 = "https://github.com/Akagilnc/ming-salvage-sim/issues/517";
  const pr1210 = "https://github.com/Akagilnc/ming-salvage-sim/pull/1210";

  // Admission binds #516; Spec-leg candidate adjudicates #517.
  await runMultiTurnPublicCliScene({
    label: "wrong-authority-source",
    role: "reviewer",
    argv: (project) => [
      "reviewer",
      "--project",
      project,
      "--base",
      "HEAD",
      "--authority-ref",
      authority516,
      "--authority-ref",
      pr1210,
      "named rejection wrong authority source",
    ],
    roleCallArguments: {
      status: "completed",
      specFetchedMaterial: {
        issueRef: authority517,
        ticketNumber: 517,
        adopted: { source: "commit-message", ticketNumber: 517 },
      },
      authorityRefs: [authority517],
    },
    auditArguments: { status: "revise", violations: ["wrong-authority-source"] },
    toolResult: { isError: true, details: { status: "errored" } },
  }, async ({ result, stdout, stderr }) => {
    const label = "wrong-authority-source";
    const { evidencePath } = await assertRejectedReviseTerminal({
      label,
      role: "reviewer",
      result,
      stdout,
      stderr,
    });
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      admittedRequestPath?: string;
      sessionFile?: string;
    };
    assert.equal(typeof evidence.admittedRequestPath, "string", label);
    assert.equal(typeof evidence.sessionFile, "string", label);
    const admitted = JSON.parse(await readFile(evidence.admittedRequestPath!, "utf8")) as {
      authorityRefs?: unknown;
    };
    // Scene proof: admission bound #516 / PR #1210 — not the Spec leg's #517.
    assert.deepEqual(admitted.authorityRefs, [authority516, pr1210], label);
    const sessionEntries = (await readFile(evidence.sessionFile!, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; name?: string; arguments?: {
            specFetchedMaterial?: { ticketNumber?: unknown; issueRef?: unknown };
            authorityRefs?: unknown;
          } }>;
        };
      });
    const roleCall = sessionEntries.find((entry) =>
      entry.type === "message"
      && entry.message?.role === "assistant"
      && Array.isArray(entry.message.content)
      && entry.message.content.some((part) =>
        part.type === "toolCall" && part.name === REVIEWER_OUTPUT_TOOL_NAME
      )
    );
    assert.ok(roleCall, `${label}: session must carry the role output call`);
    const specArgs = roleCall!.message!.content!.find(
      (part) => part.type === "toolCall" && part.name === REVIEWER_OUTPUT_TOOL_NAME,
    )!.arguments!;
    // Scene proof: report/candidate adjudicated against #517 while admission is #516.
    assert.equal(specArgs.specFetchedMaterial?.ticketNumber, 517, label);
    assert.equal(specArgs.specFetchedMaterial?.issueRef, authority517, label);
    assert.deepEqual(specArgs.authorityRefs, [authority517], label);
  });

  await runMultiTurnPublicCliScene({
    label: "empty-assistant-no-report",
    role: "reviewer",
    argv: (project) => [
      "reviewer",
      "--project",
      project,
      "--base",
      "HEAD",
      "named rejection empty assistant no report",
    ],
    roleCallArguments: { status: "completed" },
    auditArguments: { status: "revise", violations: ["empty-assistant-no-report"] },
    toolResult: { isError: true, details: { status: "errored" } },
    // Main session ends on an empty assistant message with no report.
    trailingSessionEntries: [{
      type: "message",
      message: { role: "assistant", content: [] },
    }],
  }, async ({ result, stdout, stderr }) => {
    const label = "empty-assistant-no-report";
    const { evidencePath } = await assertRejectedReviseTerminal({
      label,
      role: "reviewer",
      result,
      stdout,
      stderr,
    });
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      sessionFile?: string;
    };
    assert.equal(typeof evidence.sessionFile, "string", label);
    const sessionEntries = (await readFile(evidence.sessionFile!, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      });
    const assistants = sessionEntries.filter(
      (entry) => entry.type === "message" && entry.message?.role === "assistant",
    );
    assert.ok(assistants.length >= 1, `${label}: session must retain assistant faces`);
    const closing = assistants[assistants.length - 1]!;
    // Scene proof: session closes on empty assistant content — not a toolCall face.
    assert.deepEqual(closing.message?.content, [], label);
    assert.equal(
      result.terminal!.artifacts.some((a) => a.kind === "report"),
      false,
      `${label}: no report published`,
    );
  });
});
test("public audit evidence collision returns a typed nonzero Terminal with residual", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "audit evidence collision"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-audit-artifact-collision-001",
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          const runDir = join(sessionDir, "..");
          await mkdir(join(runDir, "artifacts", "audit-incomplete.json"), { recursive: true });
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.jsonl"),
            `${JSON.stringify({
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "role-1", name: JUDGE_OUTPUT_TOOL_NAME, arguments: { judgeStatus: "converged" } }],
              },
            })}\n${JSON.stringify({
              type: "custom",
              customType: "ak_compliance_response",
              data: { response: { content: [{ type: "toolCall", name: JUDGE_AUDIT_TOOL_NAME, arguments: ["retained"] }] } },
            })}\n${JSON.stringify({
              type: "message",
              message: {
                role: "toolResult",
                toolCallId: "role-1",
                toolName: JUDGE_OUTPUT_TOOL_NAME,
                isError: false,
                details: { status: "audit-incomplete", observation: { kind: "non-object-arguments", type: "array" }, candidate: ["ignored"] },
              },
            })}\n`,
            "utf8",
          );
          return { code: 0, stdout: "", stderr: "", timedOut: false, args: [...args] };
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 1);
    assert.ok(result.terminal);
    const outcome = result.terminal!.roleOutcome;
    assert.equal(outcome.kind, "failure");
    if (outcome.kind !== "failure") throw new Error("expected publication failure");
    assert.equal(outcome.cause, "unrecognized");
    assert.equal(outcome.decisiveFacts.errorCode, "EEXIST");
    assert.equal(outcome.auditResidual?.acceptedReceipt, false);
    assert.deepEqual(outcome.auditResidual?.roleCandidate, { judgeStatus: "converged" });
    assert.deepEqual(outcome.auditResidual?.audit.candidate, ["retained"]);
    assert.equal(result.terminal!.artifacts.length, 0);
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
test("zero-exit invalid coder details retain coder typed identity through shared output fallback", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const result = await runAkRole(
      ["coder", "apply", "--project", project, "bogus details"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-coder-output-bogus-001",
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
                toolName: CODER_OUTPUT_TOOL_NAME,
                isError: false,
                details: { status: "not-a-coder-status" },
              },
            })}\n`,
            "utf8",
          );
          return { code: 0, stderr: "", timedOut: false, args: [...args] };
        },
      },
    );

    assert.equal(result.terminal?.roleOutcome.role, "coder");
    const errorRef = result.terminal?.artifacts.find((artifact) => artifact.kind === "error");
    assert.ok(errorRef);
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as { role: string };
    assert.equal(errorBody.role, "coder");
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
async function seedDoctorIssueRuns(
  home: string,
  bookKey: string,
  issueNumber: number,
): Promise<void> {
  const runs = join(
    home,
    ".ak-roles",
    "books",
    bookKey,
    "issues",
    String(issueNumber),
    "runs",
  );
  await mkdir(join(runs, "review-001", "session"), { recursive: true });
  await writeFile(
    join(runs, "review-001", "session", "leg.jsonl"),
    `${JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "ak_coder_output",
        isError: false,
        details: { status: "completed", report: "seed" },
      },
    })}\n`,
    "utf8",
  );
}