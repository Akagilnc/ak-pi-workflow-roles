import { piDurablePrincipalAuthority, decodePiDurablePrincipal } from "../../src/pi/durable-principal.ts";
// #107 session provider-stop 绑定与 #307 typed HTTP 观察家族。
// #420 整改自 public-cli-failure-settlement.test.ts 按主题拆出；共享夹具入 kit。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { createComplianceDecisionTool, runComplianceAudit } from "../../src/compliance-transport.ts";
import { AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/engine-detour.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { knownFailureFromProviderStop, readReviewerDispatchRejection } from "../../src/public-cli/explicit-internal.ts";
import { classifyPostAdmissionFailure, extractSessionProviderStop, readBoundAuditorKnownFailure, readBoundEvidenceChildKnownFailure, readSessionProviderStop, resolveAuditedRunnerKnownFailure, settleJudgeFailureTerminalResult } from "../../src/public-cli/settlement.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readLatestTypedProviderHttpObservation } from "../../src/public-cli/run-lifecycle.ts";
import { createNativeNavigatorSessionFactory, createNavigatorPrepareTool, NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/navigator-attendance.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import { createRecordSession } from "../../src/archivist-record-entry.ts";
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
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(argv[role](project), {
      packageRoot, home, cwd: project, io,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => `run-${role}-auditor-provider-stop`,
      piRunner: async (args) => {
        const entries: unknown[] = [];
        const faux = fauxProvider({ provider: "openai-codex" });
        faux.setResponses(Array.from({ length: 3 }, () =>
          fauxAssistantMessage([], { stopReason: "error", errorMessage: "WebSocket error" }),
        ));
        await assert.rejects(runComplianceAudit({
          tool: createComplianceDecisionTool(`ak_${role}_audit_decision`, "Submit audit decision."),
          systemPrompt: "Audit.", serializedInput: "Audit role output.", roleLabel: `${role} auditor`, invalidDecisionLabel: "invalid audit decision",
          context: {
            cwd: project, model: faux.getModel(), thinkingLevel: "off",
            modelRegistry: {
              getProvider() { return faux.provider; },
              async getProviderAuth() { return { auth: { apiKey: "test" } }; },
              async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test" }; },
            },
            sessionManager: { getSessionFile() { return undefined; }, getSessionDir() { return project; }, appendCustomEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); return "entry"; } },
          } as unknown as ExtensionContext,
        }));
        entries.push({ type: "message", message: { role: "assistant", stopReason: "aborted" } });
        assert.equal(extractSessionProviderStop(entries as never)?.errorMessage, "WebSocket error");
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
        return { code: 1, stderr: "[ak-patch] normal activation banner\n", timedOut: false, args: [...args] };
      },
    });
    const { terminal } = await assertPublicFailureSettlement({ result, stdout, stderr, expectedCause: "unrecognized", diagnosticEquals: "WebSocket error" });
    assert.equal(terminal.roleOutcome.kind, "failure", `${role}: no Receipt outcome`);
  });
});
test("bound evidence-child provider stop outranks generic activation wash", async () => {
  await withTempHome(async (home) => {
    const sessionDir = join(home, "session");
    const sessionFile = join(sessionDir, "session.jsonl");
    const childDir = join(sessionDir, "evidence-children");
    await mkdir(childDir, { recursive: true });
    // Real #236 no-task dispatch shape: parent never took a model turn; only
    // fixed-axis evidence children retain the provider stop (usage limit, etc.).
    await writeFile(sessionFile, [
      { type: "session", id: "parent-session" },
      { type: "custom", customType: "ak-navigator-invocation", data: { role: "reviewer" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(join(childDir, "2026-08-10T11-28-52-705Z_child.jsonl"), [
      { type: "session", id: "child-session", parentSession: sessionFile },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Codex error: The usage limit has been reached",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    assert.deepEqual(await readBoundEvidenceChildKnownFailure(sessionFile), {
      cause: "unrecognized",
      diagnostic: "Codex error: The usage limit has been reached",
      details: {
        errorMessage: "Codex error: The usage limit has been reached",
        secondaryEvidence: "evidence-child",
      },
    });
    assert.deepEqual(
      await resolveAuditedRunnerKnownFailure({
        runner: undefined,
        sessionFile,
        credential: {
          cause: "provider",
          identity: { name: "MissingProviderCredential", code: "openai-codex" },
        },
      }),
      {
        cause: "unrecognized",
        diagnostic: "Codex error: The usage limit has been reached",
        details: {
          errorMessage: "Codex error: The usage limit has been reached",
          secondaryEvidence: "evidence-child",
        },
      },
    );
  });
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
test("bound auditor provider failure outranks the parent abort it caused", async () => {
  await withTempHome(async (home) => {
    const sessionDir = join(home, "session");
    const sessionFile = join(sessionDir, "parent.jsonl");
    const childDir = join(sessionDir, "auditor-roles");
    await mkdir(childDir, { recursive: true });
    // Real retention race shape: parent ends with abort after the child
    // already retained the richer auditor provider stop + identity.
    await writeFile(sessionFile, [
      { type: "session", id: "parent-session" },
      { type: "message", id: "parent-user", message: { role: "user" } },
      {
        type: "message",
        id: "parent-attempt",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "This operation was aborted",
          provider: "openai-codex",
          model: "faux-1",
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(join(childDir, "child.jsonl"), [
      { type: "session", id: "child-session", parentSession: sessionFile },
      {
        type: "custom",
        customType: "ak_auditor_parent_attempt_binding",
        data: {
          version: 1,
          parent: {
            sessionId: "parent-session",
            sessionFile,
            attemptEntryId: "parent-attempt",
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "WebSocket error",
          provider: "openai-codex",
          model: "faux-1",
        },
      },
      {
        type: "custom",
        customType: "ak_auditor_compliance_failure",
        data: {
          parent: {
            sessionId: "parent-session",
            sessionFile,
            attemptEntryId: "parent-attempt",
          },
          failure: {
            cause: "provider",
            diagnostic: "WebSocket error",
            identity: { name: "faux-1", code: "openai-codex" },
            details: {
              provider: "openai-codex",
              model: "faux-1",
              retentionFailure: {
                name: "ComplianceResponseRetentionError",
                cause: { code: "EISDIR" },
              },
            },
          },
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    assert.deepEqual(
      await resolveAuditedRunnerKnownFailure({
        runner: undefined,
        sessionFile,
        credential: {
          cause: "provider",
          identity: { name: "MissingProviderCredential", code: "openai-codex" },
        },
      }),
      {
        cause: "provider",
        diagnostic: "WebSocket error",
        identity: { name: "faux-1", code: "openai-codex" },
        details: {
          provider: "openai-codex",
          model: "faux-1",
          retentionFailure: {
            name: "ComplianceResponseRetentionError",
            cause: { code: "EISDIR" },
          },
        },
      },
    );
  });
});
test("retained auditor failure is bound to the latest parent resume attempt", async () => {
  await withTempHome(async (home) => {
    const sessionDir = join(home, "session");
    const sessionFile = join(sessionDir, "parent.jsonl");
    const childDir = join(sessionDir, "auditor-roles");
    await mkdir(childDir, { recursive: true });
    const parentEntries = [
      { type: "session", id: "parent-session" },
      { type: "message", id: "user-old", message: { role: "user" } },
      { type: "message", id: "attempt-old", message: { role: "assistant" } },
      { type: "message", id: "user-new", message: { role: "user" } },
      { type: "message", id: "attempt-new", message: { role: "assistant", stopReason: "error", errorMessage: "new failure" } },
    ];
    await writeFile(sessionFile, parentEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const childEntries = [
      { type: "session", id: "child-session", parentSession: sessionFile },
      { type: "custom", customType: "ak_auditor_parent_attempt_binding", data: { version: 1, parent: { sessionId: "parent-session", sessionFile, attemptEntryId: "attempt-old" } } },
      { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "stale native failure", provider: "xai", model: "audit-model" } },
      { type: "custom", customType: "ak_auditor_compliance_failure", data: { parent: { sessionId: "parent-session", sessionFile, attemptEntryId: "attempt-old" }, failure: { cause: "provider", diagnostic: "stale auditor failure" } } },
    ];
    await writeFile(join(childDir, "child.jsonl"), childEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.equal(await readBoundAuditorKnownFailure(sessionFile), undefined);
  });
});
test("bound auditor assistant supplies primary when secondary enrichment is absent", async () => {
  await withTempHome(async (home) => {
    const sessionDir = join(home, "session");
    const sessionFile = join(sessionDir, "parent.jsonl");
    const childDir = join(sessionDir, "auditor-roles");
    await mkdir(childDir, { recursive: true });
    await writeFile(sessionFile, [
      { type: "session", id: "parent-session" },
      { type: "message", id: "user-current", message: { role: "user" } },
      { type: "message", id: "attempt-current", message: { role: "assistant" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(join(childDir, "child.jsonl"), [
      { type: "session", id: "child-session", parentSession: sessionFile },
      { type: "custom", customType: "ak_auditor_parent_attempt_binding", data: { version: 1, parent: { sessionId: "parent-session", sessionFile, attemptEntryId: "attempt-current" } } },
      { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: "WebSocket error", provider: "xai", model: "audit-model" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.deepEqual(await readBoundAuditorKnownFailure(sessionFile), {
      cause: "unrecognized",
      diagnostic: "WebSocket error",
      details: {
        errorMessage: "WebSocket error",
        secondaryEvidence: "unavailable",
      },
    });
  });
});
test("bound auditor ENOTDIR evidence outranks credential in shared settlement", async () => {
  await withTempHome(async (home) => {
    const pathComponent = join(home, "not-a-directory");
    await writeFile(pathComponent, "file");
    const failure = await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile: join(pathComponent, "parent.jsonl"),
      credential: { cause: "activation", diagnostic: "credential fallback" },
    });
    assert.equal(failure?.cause, "session");
    assert.deepEqual(failure?.identity, { name: "Error", code: "ENOTDIR" });
    assert.ok(failure?.diagnostic);
  });
});
test("bound auditor reader propagates malformed discovered JSONL", async () => {
  await withTempHome(async (home) => {
    const sessionDir = join(home, "session");
    const sessionFile = join(sessionDir, "parent.jsonl");
    const childDir = join(sessionDir, "auditor-roles");
    await mkdir(childDir, { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "parent-session" }) + "\n");
    await writeFile(join(childDir, "child.jsonl"), "{malformed\n");
    await assert.rejects(readBoundAuditorKnownFailure(sessionFile), (error: unknown) =>
      error instanceof SyntaxError && (error as Error & { knownCause?: string }).knownCause === "session");
  });
});
test("Reviewer rejection sidecar rejects generic controlled failures", async () => {
  await withTempHome(async (home) => {
    const sidecar = join(home, "typed-known-failure.json");
    await writeFile(sidecar, JSON.stringify({
      cause: "provider",
      diagnostic: "generic provider failure",
      identity: { name: "ProviderError" },
      details: { arbitrary: true },
    }));
    await assert.rejects(
      readReviewerDispatchRejection(home),
      (error: unknown) => error instanceof Error && error.name === "ReviewerDispatchRejectionContractError",
    );

    await writeFile(sidecar, JSON.stringify({
      diagnostic: "Fixed Reviewer dispatch was not accepted",
      violations: ["base-invalid"],
      producerMetadata: { version: 2 },
    }));
    assert.deepEqual(await readReviewerDispatchRejection(home), {
      cause: "activation",
      diagnostic: "Fixed Reviewer dispatch was not accepted",
      identity: { name: "ReviewerDispatchRejectionError" },
      details: { violations: ["base-invalid"] },
    });

    await writeFile(sidecar, "{malformed\n");
    const malformed = await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile: join(home, "missing-session.jsonl"),
      credential: undefined,
      runDirectory: home,
    });
    assert.equal(malformed?.cause, "activation");
    assert.equal(malformed?.identity?.name, "SyntaxError");
    assert.match(malformed?.diagnostic ?? "", /JSON/);
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

    assert.equal(await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile,
      credential: undefined,
    }), undefined);
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
        },
      );
      const { terminal, errorRef } = await assertPublicFailureSettlement({
        result,
        stdout,
        stderr,
        expectedCause: "unrecognized",
        diagnosticEquals: row.errorMessage,
      });
      assert.equal(terminal.roleOutcome.kind, "failure", row.label);
      if (terminal.roleOutcome.kind === "failure") {
        assert.equal(terminal.roleOutcome.cause, "unrecognized", row.label);
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
      assert.equal(errorBody.cause, "unrecognized", row.label);
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
  assert.equal(fromStop?.cause, "unrecognized");
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
    "unrecognized",
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
test("#307 navigator raw: onResponse status reaches durable session + run typed HTTP sink", async () => {
  // S6/S7: navigator durable path is createRecordSession(kind/subject) under ledger home —
  // not a caller-supplied sessionDir / continueRecent self-computed path.
  await withHermeticHome({ prefix: "nav-raw-307-" }, async ({ home }) => {
    const previousPi = process.env.PI_CODING_AGENT_DIR;
    const previousRun = process.env.AK_ROLE_RUN_DIR;
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runDir = join(home, "run");
    // Work identity for the archivist navigator nest (same relation production factory uses).
    const subject = join(project, "session-nav-raw");
    await mkdir(runDir, { recursive: true });
    try {
      process.env.PI_CODING_AGENT_DIR = home;
      process.env.AK_ROLE_RUN_DIR = runDir;
      const faux = fauxProvider({ provider: "openai-codex", api: "openai-codex" });
      const model = faux.getModel();
      await writeFile(join(home, "navigator-model.json"), JSON.stringify({ model: `${model.provider}/${model.id}` }));
      const provider = {
        ...faux.provider,
        stream(
          requestModel: typeof model,
          streamContext: { tools?: Array<{ name: string }> },
          options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> },
        ) {
          const names = streamContext.tools?.map((tool) => tool.name) ?? [];
          if (!names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) {
            return faux.provider.stream(requestModel, streamContext as never, options as never);
          }
          const stream = createAssistantMessageEventStream();
          const human = {
            ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 503 body" }),
            body: "{\"err\":\"navigator-raw\"}",
            code: "remote_503",
            errno: -54,
          };
          queueMicrotask(() => {
            void (async () => {
              await options?.onResponse?.({ status: 503, headers: {} }, requestModel);
              stream.push({ type: "error", reason: "error", error: human });
            })();
          });
          return stream;
        },
        streamSimple(
          requestModel: typeof model,
          streamContext: { tools?: Array<{ name: string }> },
          options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> },
        ) {
          return this.stream(requestModel, streamContext, options);
        },
      };
      const nativeContext = {
        cwd: project,
        modelRegistry: {
          find: (providerName: string, id: string) =>
            providerName === model.provider && id === model.id ? model : undefined,
          getProvider: (providerName: string) => providerName === model.provider ? provider : undefined,
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
        },
      } as never;
      const session = await createNativeNavigatorSessionFactory()({
        context: nativeContext,
        subject,
        tool: createNavigatorPrepareTool(() => {}),
      });
      await session.setModel?.(`${model.provider}/${model.id}`, "off");
      await session.prompt("navigator raw");
      session.dispose();
      // Real disk path via archivist entry only — same kind/subject/cwd identity production uses.
      // Do not bypass createRecordSession with continueRecent/self-computed sessionDir.
      const diskFile = createRecordSession({
        cwd: project,
        kind: "navigator",
        subject,
      }).getSessionFile();
      assert.ok(diskFile, "navigator session must persist a session file via archivist entry");
      const diskEntries = (await readFile(diskFile, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            errorMessage?: string;
            statusCode?: number;
            body?: unknown;
            code?: unknown;
            errno?: unknown;
          };
        });
      const assistant = [...diskEntries].reverse().find(
        (entry) => entry?.type === "message" && entry?.message?.role === "assistant",
      );
      assert.equal(assistant?.message?.errorMessage, "upstream 503 body");
      assert.equal(assistant?.message?.statusCode, 503);
      assert.equal(assistant?.message?.body, "{\"err\":\"navigator-raw\"}");
      assert.equal(assistant?.message?.code, "remote_503");
      assert.equal(assistant?.message?.errno, -54);
      assert.deepEqual(await readLatestTypedProviderHttpObservation(runDir), {
        httpStatus: 503,
        provider: "openai-codex",
      });
    } finally {
      if (previousPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPi;
      if (previousRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previousRun;
    }
  });
});
test("#307 aborted raw: session aborted stop projects held payload into error.json", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj-aborted-raw");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-aborted-raw-001";
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`);
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    // Real SessionManager principal — production retain writes the target session JSON.
    const sessionManager = SessionManager.create(project, sessionDirectory);
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile);
    const faux = fauxProvider({ provider: "xai" });
    // Real auditor projector entry: return aborted stop without HTTP/diagnostics testimony.
    // Config provider/model and local-looking body/code/errno are not upstream testimony.
    await assert.rejects(runComplianceAudit({
      tool: createComplianceDecisionTool("ak_judge_audit_decision", "Submit audit decision."),
      systemPrompt: "Audit.",
      serializedInput: "aborted raw",
      roleLabel: "judge auditor",
      invalidDecisionLabel: "invalid audit decision",
      runCompletion: async () => ({
        ...fauxAssistantMessage("", {
          stopReason: "aborted",
          errorMessage: "stream aborted mid-token",
        }),
        body: "{\"abort\":true}",
        code: "aborted_upstream",
        errno: -1,
      }),
      context: {
        cwd: project,
        model: faux.getModel(),
        thinkingLevel: "off",
        modelRegistry: {
          getProvider() { return faux.provider; },
          async getProviderAuth() { return { auth: { apiKey: "test" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test" }; },
        },
        sessionManager,
      } as unknown as ExtensionContext,
    }));
    // Production retain already holds the aborted stop; flush parent session to disk.
    flushRetainedParentSession(sessionManager);
    // Disk session carries the retained aborted stop (not piRunner-synthesized JSON).
    const diskStop = await readSessionProviderStop(sessionFile);
    assert.equal(diskStop?.stopReason, "aborted");
    assert.equal(diskStop?.errorMessage, "stream aborted mid-token");
    const { errorBody } = await settleDiskSessionStopToErrorJson({
      home,
      project,
      runId,
      sessionFile,
      sessionDirectory,
      exitCode: 1,
    });
    assert.equal(errorBody.cause, "unrecognized");
    assert.equal(errorBody.diagnostic, "stream aborted mid-token");
    const details = errorBody.details as Record<string, unknown> | undefined;
    assert.equal(details?.errorMessage, "stream aborted mid-token");
    // Process exit fact is preserved separately from any remote code.
    assert.equal(details?.exitCode, 1);
    // No testimony ⇒ no provider/model identity and no body/code/errno projection.
    assert.equal(details?.provider, undefined);
    assert.equal(details?.model, undefined);
    assert.equal(details?.body, undefined);
    assert.equal(details?.code, undefined);
    assert.equal(details?.errno, undefined);
  });
});
test("#307 SDK structured payload: confirmed remote status+body reaches error.json", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj-sdk-structured");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const padded = "  500: keep surrounding spaces  ";
    const runId = "run-sdk-structured-001";
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`);
    const sessionDirectory = join(runDirectory, "session");
    await mkdir(sessionDirectory, { recursive: true });
    // Real SessionManager principal — production ak_compliance_response retain owns the bytes.
    const sessionManager = SessionManager.create(project, sessionDirectory);
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile);
    const faux = fauxProvider({ provider: "openai-codex" });
    // Real evidence-child/auditor projector seam: throw structured remote diagnostics
    // through runCompletion → projectStructuredRemote → ak_compliance_response retain.
    // Target session JSON is never hand-written by piRunner.
    await assert.rejects(runComplianceAudit({
      tool: createComplianceDecisionTool("ak_judge_audit_decision", "Submit audit decision."),
      systemPrompt: "Audit.",
      serializedInput: "SDK structured payload",
      roleLabel: "judge auditor",
      invalidDecisionLabel: "invalid audit decision",
      runCompletion: async () => {
        throw Object.assign(new Error(padded), {
          status: 500,
          statusCode: 500,
          body: "{\"upstream\":\"raw-body-bytes\"}",
          code: "remote_internal",
          errno: 61,
          diagnostics: [{ type: "provider_error", error: { message: padded } }],
        });
      },
      context: {
        cwd: project,
        model: faux.getModel(),
        thinkingLevel: "off",
        modelRegistry: {
          getProvider() { return faux.provider; },
          async getProviderAuth() { return { auth: { apiKey: "test" } }; },
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "test" }; },
        },
        sessionManager,
      } as unknown as ExtensionContext,
    }));
    // Production retain already holds the structured stop; flush parent session to disk.
    flushRetainedParentSession(sessionManager);
    const diskStop = await readSessionProviderStop(sessionFile);
    assert.equal(diskStop?.errorMessage, padded);
    assert.equal(diskStop?.httpStatus, 500);
    assert.equal(diskStop?.body, "{\"upstream\":\"raw-body-bytes\"}");
    assert.equal(diskStop?.code, "remote_internal");
    assert.equal(diskStop?.errno, 61);
    const { errorBody } = await settleDiskSessionStopToErrorJson({
      home,
      project,
      runId,
      sessionFile,
      sessionDirectory,
      exitCode: 1,
    });
    assert.equal(errorBody.cause, "provider");
    assert.equal(errorBody.diagnostic, padded);
    const details = errorBody.details as Record<string, unknown> | undefined;
    assert.equal(details?.errorMessage, padded);
    assert.equal(details?.httpStatus, 500);
    assert.equal(details?.body, "{\"upstream\":\"raw-body-bytes\"}");
    // SDK remote code and process exit code coexist without collision.
    assert.equal(details?.code, "remote_internal");
    assert.equal(details?.exitCode, 1);
    assert.equal(details?.errno, 61);
    assert.equal(details?.provider, "openai-codex");
  });
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
    assert.equal(await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    }), undefined);

    // Non-absence: existing sidecar with illegal typed shape keeps real cause on settlement chain.
    await writeFile(join(runDirectory, "typed-provider-http.json"), JSON.stringify({ httpStatus: 500 }), "utf8");
    const badShape = await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.equal(badShape?.cause, "session");
    assert.match(badShape?.diagnostic ?? "", /provider/);

    // Non-absence: malformed JSON keeps SyntaxError identity (not laundered as absence).
    await writeFile(join(runDirectory, "typed-provider-http.json"), "{not-json\n", "utf8");
    const malformed = await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.equal(malformed?.cause, "session");
    assert.equal(malformed?.identity?.name, "SyntaxError");
    assert.match(malformed?.diagnostic ?? "", /JSON/i);

    // Non-absence: EISDIR on the observation path keeps real errno cause.
    await rm(join(runDirectory, "typed-provider-http.json"), { force: true });
    await mkdir(join(runDirectory, "typed-provider-http.json"));
    const eisdir = await resolveAuditedRunnerKnownFailure({
      runner: undefined,
      sessionFile,
      credential: undefined,
      runDirectory,
    });
    assert.equal(eisdir?.cause, "session");
    assert.equal(eisdir?.identity?.code, "EISDIR");
  });
});
test("#307 typed HTTP non-absence failure settles once via controlled failure (no outer escape)", async () => {
  // Public failure tracer: EISDIR on the typed-HTTP sidecar must enter the existing
  // controlled-failure → error.json chain once. Resume must not re-read/rethrow to cli outer catch.
  await withTempHome(async (home) => {
    const project = join(home, "proj-typed-http-resume-once");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-typed-http-resume-once-001";
    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["judge", "--project", project, "typed http sidecar is a directory"],
      {
        packageRoot,
        home,
        cwd: project,
        createRunId: () => runId,
        io,
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
      },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.resume, undefined);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(result.terminal!.roleOutcome.cause, "session");
      assert.equal(result.terminal!.roleOutcome.decisiveFacts.errorCode, "EISDIR");
    }
    // Must publish error.json through controlled settlement — not wash at cli outer catch.
    const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
    assert.ok(errorRef, "controlled failure must publish error artifact");
    const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as {
      cause?: string;
      identity?: { code?: string };
    };
    assert.equal(errorBody.cause, "session");
    assert.equal(errorBody.identity?.code, "EISDIR");
    // Outer catch path prints a bare diagnostic without Terminal; controlled path keeps Terminal on stdout/structured.
    assert.equal(stdout.length + stderr.length > 0, true);
    assert.equal(
      stderr.some((line) => line.includes("unrecognized exception")),
      false,
    );
  });
});
/**
 * SessionManager defers first durable write until an assistant message exists.
 * After production ak_compliance_response retain (custom entry only), append the
 * realistic parent-aborted framing so the already-held retain bytes flush to disk.
 * Does not invent the evidence stop — extractSessionProviderStop prefers the
 * retained compliance response over this framing message.
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
  const known = await resolveAuditedRunnerKnownFailure({
    runner: undefined,
    sessionFile: input.sessionFile,
    credential: undefined,
    runDirectory,
  });
  assert.ok(known, "disk session must yield a knownFailure");
  const failure = classifyPostAdmissionFailure({
    timedOut: false,
    code: input.exitCode ?? 1,
    stderr: "",
    knownCause: known.cause,
    ...(known.diagnostic === undefined ? {} : { knownDiagnostic: known.diagnostic }),
    ...(known.identity === undefined ? {} : { knownIdentity: known.identity }),
    ...(known.details === undefined ? {} : { knownDetails: known.details }),
  });
  const admitted = {
    role: "judge" as const,
    runId: input.runId,
    bookKey,
    projectRoot: input.project,
    instruction: "x",
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    sessionDirectory: input.sessionDirectory,
    sessionFile: input.sessionFile,
    admittedRequestPath: join(runDirectory, "admitted-request.json"),
  };
  await writeFile(admitted.admittedRequestPath, "{}\n", "utf8");
  const terminal = await settleJudgeFailureTerminalResult(admitted as any, failure, piDurablePrincipalAuthority);
  const errorRef = terminal.artifacts.find((a) => a.kind === "error");
  assert.ok(errorRef, "settlement must publish error artifact");
  const errorBody = JSON.parse(await readFile(errorRef.path, "utf8")) as Record<string, unknown>;
  return { errorPath: errorRef.path, errorBody };
}