import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
// #107 failure + human-decision settlement seam — typed API / classifier core.
// #420 整改拆分：公开入口与 provider-stop 家族分片并行（同根家族聚合，无新增机制）。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { AUDIT_ESCALATION_KIND, buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { DOCTOR_AUDIT_TOOL_NAME } from "../../src/doctor-auditor.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "../../src/judge-auditor.ts";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";

import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { ExplicitInternalActivationError } from "../../src/public-cli/explicit-internal.ts";
import { ATTEMPT_HISTORY_ENTRY_TYPE, classifyPostAdmissionFailure, CONCISE_DIAGNOSTIC_MAX_CHARS, exitCodeForTerminalOutcome, extractDoctorRoleOutcome, extractJudgeRoleOutcome, isChildDiagnosticFloodLine, isChildDiagnosticHelpFooterLine, isLawfulTypedTerminalOutcome, settleJudgeFailureTerminalResult } from "../../src/public-cli/settlement.ts";
import type { ControlledFailureCause } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import {
  withTempHome,
  captureIo,
  seedGitProject,
  assertPublicFailureSettlement,
  multiTurnIntermediateRetained,
} from "../helpers/failure-settlement-kit.ts";

// Admission matrix: structural rejects before model dispatch share one root —
// nonzero exit, zero dispatch, no Terminal. Two rows cover the grammar faces.
test("malformed CLI structure and empty --project= reject structurally before admission", async () => {
  const rows = [
    {
      label: "unknown flag",
      args: (project: string) => ["judge", "--not-a-real-flag", "task", "--project", project],
    },
    {
      // Empty project must not resolve("") → cwd and complete admission/dispatch.
      label: "empty --project=",
      args: () => ["judge", "--project=", "task"],
    },
  ] as const;
  for (const row of rows) {
    await withTempHome(async (home) => {
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const { io, stdout, stderr } = captureIo();
      let dispatched = 0;
      const result = await runAkRole(row.args(project), {
        packageRoot,
        home,
        cwd: project,
        io,
        piRunner: async (args) => {
          dispatched += 1;
          return {
            code: 0,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      });
      assert.equal(result.exitCode, 2, row.label);
      assert.equal(dispatched, 0, row.label);
      assert.equal(stdout.length, 0, row.label);
      assert.equal(stderr.length >= 1, true, row.label);
      // Typed admission oracle: structural reject never produces a Terminal.
      assert.equal(result.terminal, undefined, row.label);
    });
  }
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
  const timeout = classifyPostAdmissionFailure({
    timedOut: true,
    code: null,
    stderr: floodStderr(),
  });
  assert.equal(timeout.cause, "timeout");
  assert.deepEqual(timeout.details, { timedOut: true, exitCode: null });

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
  assert.deepEqual(timedOutWithProvider.details, {
    exitCode: null,
    timedOut: true,
  });

  const reservedKnownDetails = classifyPostAdmissionFailure({
    timedOut: false,
    code: 1,
    stderr: "",
    knownCause: "provider",
    knownDiagnostic: "upstream unavailable",
    knownDetails: { code: 99, timedOut: true, provider: "xai" },
  });
  assert.deepEqual(reservedKnownDetails.details, {
    provider: "xai",
    code: 99,
    exitCode: 1,
  });

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

    const terminal = await settleJudgeFailureTerminalResult(admitted as any, {
      cause: "activation",
      diagnostic: "role infrastructure failed",
    });
    assert.equal(terminal.roleOutcome.kind, "failure");
    assert.equal(terminal.navigator.disposition, "no-advice");
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
      // stderr oracle is emission shape + non-flood — not selected diagnostic prose (AC6):
      // stack frames, JSONL event lines, and token counters must never surface.
      assert.equal(stderr[0]!.includes("tool_execution_end"), false);
      assert.equal(stderr[0]!.includes("at Object.fn"), false);
      assert.equal(stderr[0]!.includes("event:"), false);
      assert.equal(stderr[0]!.includes("tokens="), false);
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
test("audit escalation requires the retained seat-bound response across all audited seats", () => {
  const seats = {
    judge: { output: JUDGE_OUTPUT_TOOL_NAME, audit: JUDGE_AUDIT_TOOL_NAME },
    doctor: { output: DOCTOR_OUTPUT_TOOL_NAME, audit: DOCTOR_AUDIT_TOOL_NAME },
  } as const;
  const auditCandidate = {
    status: "escalate",
    conflicts: ["authority conflict"],
    decisionGate: { question: "Who decides?", options: ["owner", "caller"] },
  };
  const extract = (role: (typeof AUDITOR_SOUL_ROLES)[number], entries: readonly unknown[]) => {
    switch (role) {
      case "judge": return extractJudgeRoleOutcome(entries as never);
      case "doctor": return extractDoctorRoleOutcome(entries as never);
    }
  };
  const outcomeKind = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return undefined;
    return "outcome" in value
      ? (value as { outcome?: { kind?: unknown } }).outcome?.kind
      : (value as { kind?: unknown }).kind;
  };
  const hostileRows = {
    judge: { source: "public", property: "conflicts" },
    doctor: { source: "retained", property: "decisionGate" },
  } as const;
  for (const role of AUDITOR_SOUL_ROLES) {
    const seat = seats[role];
    const roleCallId = `${role}-role-call`;
    const roleCall = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: roleCallId, name: seat.output, arguments: { role } }],
      },
    };
    const retained = {
      type: "custom",
      customType: "ak_compliance_response",
      data: {
        version: 1,
        response: { content: [{ type: "toolCall", name: seat.audit, arguments: auditCandidate }] },
      },
    };
    const projected = buildAuditEscalationResult(
      { status: "escalate", conflicts: auditCandidate.conflicts, decisionGate: auditCandidate.decisionGate },
      { role },
    );
    const details = JSON.parse(JSON.stringify(projected));
    // Persisted/replayed details have no live object brand. The retained
    // seat-bound response below, not Navigator shape recognition, owns this
    // escalation's authenticity.
    assert.notEqual(
      publicNavigatorSettlement(role, null, {
        toolName: seat.output,
        isError: false,
        details,
      })?.kind,
      "human_decision",
      `${role}: persisted genuine projection must not impersonate live identity`,
    );
    const result = {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: roleCallId,
        toolName: seat.output,
        isError: false,
        details,
      },
    };
    const entries = [roleCall, retained, result];
    const extracted = extract(role, entries);
    assert.equal(outcomeKind(extracted), "audit_escalation", role);

    // Two seat-bound audit decisions in the same interval remain ambiguous
    // (multi-turn intermediates reuse the single shared fixture).
    assert.equal(
      outcomeKind(extract(role, [
        roleCall,
        ...multiTurnIntermediateRetained(`${role}-run`),
        retained,
        retained,
        result,
      ])),
      undefined,
      `${role}: duplicate seat-bound matches still fail closed`,
    );

    // One real-extractor, four-seat negative table covers both retained and
    // public audit-owned accessors. Raw toolResult evidence remains in entries,
    // but a hostile read cannot escape or produce any Receipt-shaped outcome.
    const hostile = hostileRows[role];
    const hostileCandidate = { ...auditCandidate };
    const hostileDetails = { ...details };
    Object.defineProperty(
      hostile.source === "retained" ? hostileCandidate : hostileDetails,
      hostile.property,
      { enumerable: true, get: () => { throw new Error(`${role} hostile ${hostile.property}`); } },
    );
    const hostileRetained = {
      ...retained,
      data: { response: { content: [{ type: "toolCall", name: seat.audit, arguments: hostileCandidate }] } },
    };
    const hostileResult = {
      ...result,
      message: { ...result.message, details: hostileDetails },
    };
    let hostileOutcome: unknown;
    assert.doesNotThrow(() => {
      hostileOutcome = extract(role, [roleCall, hostileRetained, hostileResult]);
    }, `${role}: hostile ${hostile.source} ${hostile.property}`);
    assert.equal(outcomeKind(hostileOutcome), undefined, `${role}: hostile evidence must not settle`);
    assert.equal(hostileResult.message.details, hostileDetails, `${role}: raw terminal remains observable`);

    assert.notEqual(
      publicNavigatorSettlement(role, null, {
        toolName: seat.output,
        isError: false,
        details: { kind: AUDIT_ESCALATION_KIND, conflicts: ["forged"], auditDecisionGate: auditCandidate.decisionGate },
      })?.kind,
      "human_decision",
      `${role}: persisted forged projection`,
    );

    // A copied kind is not enough: no retained evidence, pass evidence, wrong
    // seat, missing role id, collision, and out-of-interval evidence all fail closed.
    assert.equal(outcomeKind(extract(role, [result])), undefined, `${role}: smuggle`);
    assert.equal(
      outcomeKind(extract(role, [roleCall, { ...retained, data: { response: { content: [{ type: "toolCall", name: seat.audit, arguments: { status: "pass" } }] } } }, result])),
      undefined,
      `${role}: pass evidence`,
    );
    assert.equal(
      outcomeKind(extract(role, [roleCall, { ...retained, data: { response: { content: [{ type: "toolCall", name: "wrong-seat-audit", arguments: auditCandidate }] } } }, result])),
      undefined,
      `${role}: wrong seat`,
    );
    assert.equal(
      outcomeKind(extract(role, [{ ...roleCall, message: { ...roleCall.message, content: [{ ...roleCall.message.content[0], id: undefined }] } }, retained, result])),
      undefined,
      `${role}: missing id`,
    );
    assert.equal(outcomeKind(extract(role, [roleCall, retained, result, result])), undefined, `${role}: duplicate result`);
    assert.equal(outcomeKind(extract(role, [retained, roleCall, result])), undefined, `${role}: outside interval`);
  }
});


test("#419 failed attempt joins history and a later accepted attempt overwrites only pointer views", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    let calls = 0;
    let sessionFile = "";
    const result = await runAkRole(
      ["judge", "--project", project, "failure then accepted across legs"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => "run-419-pointer-overwrite-001",
        io,
        piRunner: async (args) => {
          calls += 1;
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          sessionFile = join(sessionDir, "session.jsonl");
          await mkdir(sessionDir, { recursive: true });
          if (calls === 1) {
            await writeFile(sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`, "utf8");
            return { code: 1, stderr: "fail\n", timedOut: false, args: [...args] };
          }
          const prior = await readFile(sessionFile, "utf8");
          await writeFile(
            sessionFile,
            `${prior}${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: JUDGE_OUTPUT_TOOL_NAME, isError: false, details: { judgeStatus: "converged", note: "resumed ok" } } })}\n`,
            "utf8",
          );
          return { code: 0, stdout: "", stderr: "", timedOut: false, args: [...args] };
        },
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal!.roleOutcome.kind, "accepted");
    assert.equal(result.terminal!.autoResumeCount, 1);

    const history = (await readFile(sessionFile, "utf8"))
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as any)
      .filter((row) => row.type === "custom" && row.customType === ATTEMPT_HISTORY_ENTRY_TYPE) as Array<{
        data: { sequence?: number; outcome?: { kind?: string; diagnostic?: string } };
      }>;
    assert.equal(history.length, 2);
    assert.equal(history[0]!.data.outcome?.kind, "failure", "failed leg's complete result is retained");
    assert.equal(typeof history[0]!.data.outcome?.diagnostic, "string");
    assert.equal(history[1]!.data.outcome?.kind, "accepted");
    assert.equal(history[0]!.data.sequence, 1);
    assert.equal(history[1]!.data.sequence, 2);

    // report/evidence stay last-write-wins views of the final accepted attempt.
    const runDirectory = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), "runs", "run-419-pointer-overwrite-001@judge");
    const report = JSON.parse(await readFile(join(runDirectory, "artifacts", "report.json"), "utf8")) as { outcome?: { kind?: string; status?: string } };
    assert.equal(report.outcome?.kind, "accepted");
    assert.equal(report.outcome?.status, "converged");
    await readFile(join(runDirectory, "artifacts", "evidence.json"), "utf8");
  });
});

test("Judge settlement separates missing or unknown discriminators from known continue", () => {
  const extract = (details: unknown) => extractJudgeRoleOutcome([
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

  const missingOrUnknown: unknown[] = [
    undefined,
    null,
    1,
    {},
    { judgeStatus: "bogus" },
    { judgeStatus: "accepted" },
    Object.defineProperty({}, "judgeStatus", { get: () => { throw new Error("hostile status"); } }),
  ];
  for (const details of missingOrUnknown) {
    assert.equal(extract(details), undefined);
  }

  const hostileOptional = Object.defineProperties(
    { judgeStatus: "continue" },
    {
      fix: { get: () => { throw new Error("hostile fix"); } },
      classes: { get: () => { throw new Error("hostile classes"); } },
    },
  );
  const knownContinue: Array<{ details: unknown; facts: Record<string, unknown> }> = [
    { details: { judgeStatus: "continue" }, facts: { judgeStatus: "continue" } },
    { details: { judgeStatus: "continue", fix: null, classes: null }, facts: { judgeStatus: "continue" } },
    { details: { judgeStatus: "continue", fix: { summary: "x" } }, facts: { judgeStatus: "continue", fixSummary: "x" } },
    { details: { judgeStatus: "continue", classes: [] }, facts: { judgeStatus: "continue", classes: [], classCount: 0 } },
    { details: hostileOptional, facts: { judgeStatus: "continue" } },
  ];
  for (const { details, facts } of knownContinue) {
    const outcome = extract(details);
    assert.equal(outcome?.kind, "accepted");
    assert.equal(outcome?.status, "continue");
    assert.deepEqual(outcome?.decisiveFacts, facts);
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
      const terminal = await settleJudgeFailureTerminalResult(admitted as any, {
        cause,
        diagnostic: `diagnostic for ${cause}`,
        identity: { name: "CauseProbeError", code: cause },
      });
      assert.equal(terminal.roleOutcome.kind, "failure");
      if (terminal.roleOutcome.kind !== "failure") throw new Error("expected failure");
      assert.equal(terminal.roleOutcome.cause, cause);
      assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
      assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);

      // Durability before caller presentation (absorbed from the former
      // dedicated durable-recordings test): artifact paths already openable,
      // evidence leg present, and no session attendance → typed unavailable.
      if (cause === "activation") {
        assert.equal(terminal.navigator.disposition, "unavailable");
        if (terminal.navigator.disposition === "unavailable") {
          assert.equal(terminal.navigator.source, "unknown");
          assert.equal(typeof terminal.navigator.reason, "string");
        }
        assert.equal(terminal.artifacts.some((a) => a.kind === "evidence"), true);
      }
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