// #420 整改：自 contract/navigator-attendance-seams.test.ts 按性质移出——绑定真实
// pi-coding-agent SessionManager 全生命周期（session_start → prepare → settlement，
// 真 host 会话装配），不属开发内环快档。契约逐断言不变。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { resolvePiContextAtCompositionRoot } from "../../src/pi/adapter.ts";
import { createNavigatorAttendance, createNavigatorPrepareTool, NAVIGATOR_PREPARE_TOOL_NAME, NavigatorUnavailableError } from "../../src/navigator-attendance.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { loadNavigatorWorkContext, resolveNavigatorAuthorityMaterial } from "../../extensions/role-runtime.ts";
import {
  context,
  candidate,
  cleanupTempDir,
  sessionHarness,
  attendance,
  settleAnsweringRebind,
} from "../helpers/navigator-attendance-kit.ts";

test("exact-session resume keeps principal; terminal starts next invocation; non-UUIDv7 rejected", async () => {
  const { basename } = await import("node:path");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createRoleRuntimeExtension } = await import("../../src/role-runtime.ts");
  const {
    NAVIGATOR_INVOCATION_ENTRY,
    buildNavigatorInfrastructureFailureFact,
    classifyPackagedRoleTerminalResult,
    currentInvocationPrincipalFromSession,
    isDurablePackagedRoleTerminalResult,
    isNavigatorInfrastructureFailureFact,
    resolveLifecycleInvocationPrincipal,
  } = await import("../../src/navigator-invocation-identity.ts");
  const { isUuidV7 } = await import("../../src/uuidv7.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");
  const { extractNavigatorFact } = await import("../../src/public-cli/settlement.ts");
  const { JUDGE_OUTPUT_TOOL_NAME } = await import("../../src/package-contracts/judge-output.ts");
  const { PACKAGED_ROLE_REGISTRY } = await import("../../src/packaged-role-registry.ts");
  const { publicNavigatorSettlement } = await import("../../src/role-runtime.ts");

  // Pure lifecycle resolver: resume vs mint boundaries (no process conflation).
  const validA = "019f8c2a-7b3e-7d11-8a4f-1c2d3e4f5a6b";
  const validB = "019f8c2a-0000-7000-8000-000000000001";
  const forged = "caller-overwrite-not-uuidv7";
  const marker = (invocationId: string, role = "judge", phase: string | null = null) => ({
    type: "custom" as const,
    customType: NAVIGATOR_INVOCATION_ENTRY,
    data: { invocationId, role, phase, subjectKey: "/repo/.ak/work" },
  });
  const toolResult = (
    toolName: string,
    opts: { isError?: boolean; details?: unknown } = {},
  ) => ({
    type: "message" as const,
    message: {
      role: "toolResult" as const,
      toolName,
      isError: opts.isError === true,
      details: opts.details ?? {},
    },
  });
  const terminal = toolResult(JUDGE_OUTPUT_TOOL_NAME, {
    isError: false,
    details: { judgeStatus: "converged" },
  });
  const attendanceAfter = (invocationId: string, role = "judge", phase: string | null = null) => ({
    type: "custom_message" as const,
    customType: "ak-navigator-attendance",
    message: {
      details: {
        version: 1,
        disposition: "no-advice",
        invocationId,
        role,
        phase,
        subjectKey: "/repo/.ak/work",
      },
    },
  });

  const fresh = resolveLifecycleInvocationPrincipal([]);
  assert.equal(fresh.resume, false);
  assert.equal(isUuidV7(fresh.invocationId), true);

  const unfinished = resolveLifecycleInvocationPrincipal([marker(validA)]);
  assert.equal(unfinished.resume, true);
  assert.equal(unfinished.invocationId, validA);

  const afterTerminal = resolveLifecycleInvocationPrincipal([marker(validA), terminal]);
  assert.equal(afterTerminal.resume, false);
  assert.equal(isUuidV7(afterTerminal.invocationId), true);
  assert.notEqual(afterTerminal.invocationId, validA);

  // Registry-driven durable completion matrix across all seven roles and phase variants.
  const infraFact = buildNavigatorInfrastructureFailureFact();
  for (const entry of PACKAGED_ROLE_REGISTRY) {
    for (const phase of entry.phases) {
      const acceptedDetails =
        entry.role === "judge"
          ? { judgeStatus: "converged" }
          : entry.role === "fixer" || entry.role === "coder"
            ? { status: "completed", report: "done" }
            : { status: "completed" };
      const acceptedMsg = {
        toolName: entry.outputTool,
        isError: false,
        details: acceptedDetails,
      };
      const retryableMsg = {
        toolName: entry.outputTool,
        isError: true,
        details: { message: "correctable schema wording" },
      };
      const infraMsg = {
        toolName: entry.outputTool,
        isError: true,
        details: infraFact,
      };
      // Shared gate agrees with settlement projection for accepted / retryable / infra.
      assert.equal(isDurablePackagedRoleTerminalResult(acceptedMsg), true, `${entry.role}:${String(phase)}:accepted`);
      assert.equal(isDurablePackagedRoleTerminalResult(retryableMsg), false, `${entry.role}:${String(phase)}:retryable`);
      assert.equal(isDurablePackagedRoleTerminalResult(infraMsg), true, `${entry.role}:${String(phase)}:infra`);

      // Typed negative regressions: missing / non-boolean / zero / contradictory / malformed infra fail closed.
      const missingIsErrorMsg = {
        toolName: entry.outputTool,
        details: acceptedDetails,
      };
      const stringFalseIsErrorMsg = {
        toolName: entry.outputTool,
        isError: "false" as unknown as boolean,
        details: acceptedDetails,
      };
      const zeroIsErrorMsg = {
        toolName: entry.outputTool,
        isError: 0 as unknown as boolean,
        details: acceptedDetails,
      };
      const contradictoryAcceptedInfraMsg = {
        toolName: entry.outputTool,
        isError: false,
        details: infraFact,
      };
      const extraKeyInfraMsg = {
        toolName: entry.outputTool,
        isError: true,
        details: { ...infraFact, extra: "not-closed" },
      };
      const malformedInfraMsg = {
        toolName: entry.outputTool,
        isError: true,
        details: { kind: "role_infrastructure_failure", source: "other", reasonCode: "host_failure" },
      };
      assert.equal(classifyPackagedRoleTerminalResult(acceptedMsg).kind, "accepted", `${entry.role}:${String(phase)}:classify-accepted`);
      assert.equal(classifyPackagedRoleTerminalResult(infraMsg).kind, "infrastructure", `${entry.role}:${String(phase)}:classify-infra`);
      assert.equal(classifyPackagedRoleTerminalResult(retryableMsg).kind, "nonterminal", `${entry.role}:${String(phase)}:classify-retryable`);
      assert.equal(isDurablePackagedRoleTerminalResult(missingIsErrorMsg), false, `${entry.role}:${String(phase)}:missing-isError`);
      assert.equal(isDurablePackagedRoleTerminalResult(stringFalseIsErrorMsg), false, `${entry.role}:${String(phase)}:string-false-isError`);
      assert.equal(isDurablePackagedRoleTerminalResult(zeroIsErrorMsg), false, `${entry.role}:${String(phase)}:zero-isError`);
      assert.equal(isDurablePackagedRoleTerminalResult(contradictoryAcceptedInfraMsg), false, `${entry.role}:${String(phase)}:contradictory-accepted-infra`);
      // Extra fields keep infrastructure durable completion; exact closed fact still rejects extras (#475 / ADR 0040).
      assert.equal(isDurablePackagedRoleTerminalResult(extraKeyInfraMsg), true, `${entry.role}:${String(phase)}:extra-key-infra-durable`);
      assert.equal(classifyPackagedRoleTerminalResult(extraKeyInfraMsg).kind, "infrastructure", `${entry.role}:${String(phase)}:extra-key-infra-classify`);
      assert.equal(isDurablePackagedRoleTerminalResult(malformedInfraMsg), false, `${entry.role}:${String(phase)}:malformed-infra`);
      assert.equal(isNavigatorInfrastructureFailureFact(extraKeyInfraMsg.details), false, `${entry.role}:${String(phase)}:closed-fact-extras`);
      assert.equal(isNavigatorInfrastructureFailureFact(malformedInfraMsg.details), false, `${entry.role}:${String(phase)}:closed-fact-wrong-source`);

      assert.notEqual(
        publicNavigatorSettlement(entry.role, phase, acceptedMsg)?.kind,
        undefined,
        `${entry.role}:${String(phase)}:settlement-accepted`,
      );
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, retryableMsg),
        undefined,
        `${entry.role}:${String(phase)}:settlement-retryable`,
      );
      assert.deepEqual(
        publicNavigatorSettlement(entry.role, phase, infraMsg),
        { kind: "role_infrastructure_failure", role: entry.role, phase },
        `${entry.role}:${String(phase)}:settlement-infra`,
      );
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, missingIsErrorMsg as { toolName: string; isError: boolean; details: unknown }),
        undefined,
        `${entry.role}:${String(phase)}:settlement-missing-isError`,
      );
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, stringFalseIsErrorMsg),
        undefined,
        `${entry.role}:${String(phase)}:settlement-string-false-isError`,
      );
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, zeroIsErrorMsg),
        undefined,
        `${entry.role}:${String(phase)}:settlement-zero-isError`,
      );
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, contradictoryAcceptedInfraMsg),
        undefined,
        `${entry.role}:${String(phase)}:settlement-contradictory-accepted-infra`,
      );
      assert.deepEqual(
        publicNavigatorSettlement(entry.role, phase, extraKeyInfraMsg),
        { kind: "role_infrastructure_failure", role: entry.role, phase },
        `${entry.role}:${String(phase)}:settlement-extra-key-infra`,
      );
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, malformedInfraMsg),
        undefined,
        `${entry.role}:${String(phase)}:settlement-malformed-infra`,
      );

      const roleMarker = marker(validA, entry.role, phase);
      // Accepted terminal completes → mint next.
      const afterAccepted = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: false, details: acceptedDetails }),
      ]);
      assert.equal(afterAccepted.resume, false, `${entry.role}:${String(phase)}:after-accepted-resume`);
      assert.notEqual(afterAccepted.invocationId, validA, `${entry.role}:${String(phase)}:after-accepted-id`);

      // Ordinary correctable isError does NOT complete → resume same principal.
      const afterRetryable = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: true, details: { message: "correctable schema wording" } }),
      ]);
      assert.equal(afterRetryable.resume, true, `${entry.role}:${String(phase)}:after-retryable-resume`);
      assert.equal(afterRetryable.invocationId, validA, `${entry.role}:${String(phase)}:after-retryable-id`);

      // Genuine infrastructure failure completes and stays readable after restart.
      const afterInfra = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: true, details: infraFact }),
      ]);
      assert.equal(afterInfra.resume, false, `${entry.role}:${String(phase)}:after-infra-resume`);
      assert.notEqual(afterInfra.invocationId, validA, `${entry.role}:${String(phase)}:after-infra-id`);

      // Fail-closed negatives resume the current principal (do not mint next).
      const afterMissingIsError = resolveLifecycleInvocationPrincipal([
        roleMarker,
        {
          type: "message" as const,
          message: {
            role: "toolResult" as const,
            toolName: entry.outputTool,
            details: acceptedDetails,
          },
        },
      ]);
      assert.equal(afterMissingIsError.resume, true, `${entry.role}:${String(phase)}:after-missing-isError-resume`);
      assert.equal(afterMissingIsError.invocationId, validA, `${entry.role}:${String(phase)}:after-missing-isError-id`);

      const afterStringFalseIsError = resolveLifecycleInvocationPrincipal([
        roleMarker,
        {
          type: "message" as const,
          message: {
            role: "toolResult" as const,
            toolName: entry.outputTool,
            isError: "false",
            details: acceptedDetails,
          },
        },
      ]);
      assert.equal(afterStringFalseIsError.resume, true, `${entry.role}:${String(phase)}:after-string-false-resume`);
      assert.equal(afterStringFalseIsError.invocationId, validA, `${entry.role}:${String(phase)}:after-string-false-id`);

      const afterContradictoryAcceptedInfra = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: false, details: infraFact }),
      ]);
      assert.equal(afterContradictoryAcceptedInfra.resume, true, `${entry.role}:${String(phase)}:after-contradictory-resume`);
      assert.equal(afterContradictoryAcceptedInfra.invocationId, validA, `${entry.role}:${String(phase)}:after-contradictory-id`);

      // human_decision (isError:false escalate-shaped) completes.
      if (entry.role === "judge") {
        const afterHuman = resolveLifecycleInvocationPrincipal([
          roleMarker,
          toolResult(entry.outputTool, { isError: false, details: { judgeStatus: "escalate", report: "owner" } }),
        ]);
        assert.equal(afterHuman.resume, false, "judge:human-decision-completes");
        assert.notEqual(afterHuman.invocationId, validA);
      }

      // Interrupted before terminal: resume.
      const beforeTerminal = resolveLifecycleInvocationPrincipal([roleMarker]);
      assert.equal(beforeTerminal.resume, true, `${entry.role}:${String(phase)}:before-terminal`);
      assert.equal(beforeTerminal.invocationId, validA);

      // Interrupted after durable terminal (before attendance): still completed.
      const afterTerminalBeforeAttendance = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: false, details: acceptedDetails }),
      ]);
      assert.equal(afterTerminalBeforeAttendance.resume, false, `${entry.role}:${String(phase)}:after-terminal-before-attendance`);

      // Interrupted after terminal + attendance: still completed; next mints fresh.
      const afterAttendance = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: false, details: acceptedDetails }),
        attendanceAfter(validA, entry.role, phase),
      ]);
      assert.equal(afterAttendance.resume, false, `${entry.role}:${String(phase)}:after-attendance`);
      assert.notEqual(afterAttendance.invocationId, validA);

      // Retryable rejection even with later attendance noise does not complete via isError alone.
      // (attendance without durable terminal is not a completion signal for principal minting.)
      const retryableOnly = resolveLifecycleInvocationPrincipal([
        roleMarker,
        toolResult(entry.outputTool, { isError: true, details: { message: "soul correction" } }),
        attendanceAfter(validA, entry.role, phase),
      ]);
      assert.equal(retryableOnly.resume, true, `${entry.role}:${String(phase)}:retryable-not-papered`);
      assert.equal(retryableOnly.invocationId, validA);
    }
  }

  // Malformed latest: no stale fallback to older valid marker.
  const malformedLatest = resolveLifecycleInvocationPrincipal([
    marker(validA),
    marker(forged),
  ]);
  assert.equal(malformedLatest.resume, false);
  assert.equal(isUuidV7(malformedLatest.invocationId), true);
  assert.notEqual(malformedLatest.invocationId, validA);

  // Contradictory marker role/phase/subject must not resume.
  const unfinishedJudge = resolveLifecycleInvocationPrincipal([marker(validA, "judge", null)], {
    role: "judge",
    phase: null,
    subjectKey: "/repo/.ak/work",
  });
  assert.equal(unfinishedJudge.resume, true);
  assert.equal(unfinishedJudge.invocationId, validA);
  const wrongRoleResume = resolveLifecycleInvocationPrincipal([marker(validA, "coder", "apply")], {
    role: "judge",
    phase: null,
    subjectKey: "/repo/.ak/work",
  });
  assert.equal(wrongRoleResume.resume, false);
  assert.notEqual(wrongRoleResume.invocationId, validA);
  const wrongPhaseResume = resolveLifecycleInvocationPrincipal([marker(validA, "judge", null)], {
    role: "judge",
    phase: "apply",
    subjectKey: "/repo/.ak/work",
  });
  assert.equal(wrongPhaseResume.resume, false);
  const wrongSubjectResume = resolveLifecycleInvocationPrincipal([marker(validA, "judge", null)], {
    role: "judge",
    phase: null,
    subjectKey: "/other/work",
  });
  assert.equal(wrongSubjectResume.resume, false);

  // Reader rejects non-UUIDv7 nearest (forged matching marker+attendance cannot bind).
  assert.equal(
    currentInvocationPrincipalFromSession([marker(validB), marker(forged)], 2),
    undefined,
  );
  assert.equal(currentInvocationPrincipalFromSession([marker(validA)], 1), validA);
  const forgedAttendance = extractNavigatorFact([
    marker(forged),
    terminal,
    {
      type: "custom_message",
      customType: "ak-navigator-attendance",
      message: {
        details: {
          version: 1,
          disposition: "recommendation",
          invocationId: forged,
          role: "judge",
          phase: null,
          subjectKey: "/repo/.ak/work",
          next: { role: "fixer", phase: "apply" },
          reason: "forged",
        },
      },
    },
  ] as never);
  assert.equal(forgedAttendance.disposition, "unavailable");

  await withActivationHome({ prefix: "ak-nav-principal-" }, async ({ home }) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const roleSessionEntries: Array<{ type: string; customType?: string; data?: unknown; message?: unknown }> = [];
    let attendanceInvocationId: string | undefined;
    let settleEvent: { invocationId?: string; disposition?: string } | undefined;
    const modelSettingPath = join(home, "navigator-model.json");
    await writeFile(modelSettingPath, JSON.stringify({ model: "provider/model" }));

    // Shared with appendEntry so resume inspects the admitted exact session.
    let sessionManager: ReturnType<typeof SessionManager.create>;

    const pi = {
      registerFlag() {},
      getFlag(name: string) {
        return name === "ak-role" ? "judge" : undefined;
      },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(name, handler);
      },
      registerTool() {},
      getAllTools() {
        return [];
      },
      setActiveTools() {},
      // Production ExtensionAPI boundary — persists onto the admitted session principal.
      appendEntry(customType: string, data?: unknown) {
        roleSessionEntries.push({ type: "custom", customType, data });
        sessionManager.appendCustomEntry(customType, data);
      },
      async sendMessage(message: { customType?: string; details?: unknown }) {
        if (message.customType === "ak-navigator-attendance") {
          roleSessionEntries.push({
            type: "custom_message",
            customType: message.customType,
            message: { details: message.details },
          });
        }
      },
    };

    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW",
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" }),
      loadNavigatorWorkContext: async () => ({
        subjectKey: `${home}/.ak/work`,
        subject: "exact principal lifecycle",
        authority: "owner authority",
        subjectProvenance: "role_input" as const,
      }),
      createNavigatorAttendance: (options) => {
        attendanceInvocationId = options.invocationId;
        const nav = createNavigatorAttendance({
          ...options,
          context: resolvePiContextAtCompositionRoot(options.context),
          modelSettingPath,
          loadSoul: async () => "route law",
          loadRoleHelp: async (role) => `Usage: ak-role ${role}`,
          createSession: async ({ tool }) => ({
            async prompt() {
              await tool.execute(
                "prep-principal",
                {
                  candidates: [{
                    next: { role: "fixer", phase: "apply" },
                    reason: "continue to fixer",
                  }],
                } as never,
                undefined,
                undefined,
                {} as never,
              );
            },
            appendEntry() {},
            entries: () => [],
            recordPointer: () => "/fixture/navigator-record",
            dispose() {},
          }),
          onEvent: async (event, report) => {
            settleEvent = event;
            await options.onEvent(event, report);
          },
        });
        return nav;
      },
    })(pi as never);

    const sessionDir = join(
      home,
      ".ak-roles",
      "books",
      basename(home),
      "runs",
      "judge-principal",
      "session",
    );
    await mkdir(sessionDir, { recursive: true });
    sessionManager = SessionManager.create(home, sessionDir);
    sessionManager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const ctx = { cwd: home, sessionManager, abort() {} };

    await handlers.get("session_start")?.({}, ctx);

    const markers = roleSessionEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY,
    );
    assert.equal(markers.length, 1, "lifecycle writes exactly one principal marker via pi.appendEntry");
    const markerId = (markers[0]?.data as { invocationId?: string } | undefined)?.invocationId;
    assert.equal(typeof markerId, "string");
    assert.equal(isUuidV7(markerId), true, "principal is globally unique opaque uuidv7");
    assert.equal(attendanceInvocationId, markerId, "attendance receives the exact lifecycle principal");
    // Opaque: not derived from session id / sequence spelling.
    assert.equal(String(markerId).includes(sessionManager.getSessionId()), false);
    assert.match(String(markerId), /^[0-9a-f-]{36}$/i);
    assert.equal(String(markerId).includes(":"), false);

    // Exact-session process restart before terminal resumes the same principal (one marker).
    await handlers.get("session_start")?.({}, ctx);
    const markersAfterResume = roleSessionEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY,
    );
    assert.equal(markersAfterResume.length, 1, "resume must not append a second marker");
    assert.equal(attendanceInvocationId, markerId, "exact-session resume keeps the same principal");

    // Developer-style reopen of the same session file before terminal also resumes.
    const reopened = SessionManager.open(sessionManager.getSessionFile()!);
    const developerResolved = resolveLifecycleInvocationPrincipal(reopened.getEntries());
    assert.equal(developerResolved.resume, true);
    assert.equal(developerResolved.invocationId, markerId);

    // Ordinary correctable isError on the exact session does NOT complete the invocation.
    sessionManager.appendMessage({
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId: "judge-retryable",
      isError: true,
      content: [{ type: "text", text: "correctable schema wording" }],
      timestamp: Date.now(),
      details: { message: "correctable schema wording" },
    } as never);
    const afterRetryable = resolveLifecycleInvocationPrincipal(sessionManager.getEntries());
    assert.equal(afterRetryable.resume, true, "retryable isError keeps principal open");
    assert.equal(afterRetryable.invocationId, markerId);
    // Process restart after retryable rejection resumes the same principal (no fresh mint).
    await handlers.get("session_start")?.({}, ctx);
    const markersAfterRetryable = roleSessionEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY,
    );
    assert.equal(markersAfterRetryable.length, 1, "retryable rejection must not mint a new principal");
    assert.equal(attendanceInvocationId, markerId, "restart after retryable resumes same principal");

    // Drive prepare + accepted terminal settlement on the resumed principal.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await handlers.get("tool_result")?.({
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId: "judge-out",
      isError: false,
      content: [{ type: "text", text: "Judge verdict accepted" }],
      details: { judgeStatus: "converged" },
    }, ctx);
    // Persist packaged role terminal onto the admitted session (completes the invocation).
    sessionManager.appendMessage({
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId: "judge-out",
      isError: false,
      content: [{ type: "text", text: "Judge verdict accepted" }],
      timestamp: Date.now(),
      details: { judgeStatus: "converged" },
    } as never);
    await handlers.get("agent_settled")?.({}, ctx);

    assert.ok(settleEvent);
    assert.equal(settleEvent?.invocationId, markerId);
    assert.equal(settleEvent?.disposition, "recommendation");

    // Same session after accepted role terminal is a new invocation → fresh principal.
    await handlers.get("session_start")?.({}, ctx);
    const markersAfterTerminal = roleSessionEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY,
    );
    assert.equal(markersAfterTerminal.length, 2, "completed invocation mints+appends a fresh marker");
    const nextId = (markersAfterTerminal[1]?.data as { invocationId?: string } | undefined)?.invocationId;
    assert.equal(isUuidV7(nextId), true);
    assert.notEqual(nextId, markerId, "next invocation in the same session gets a fresh principal");
    assert.equal(attendanceInvocationId, nextId);

    // Genuine infrastructure failure completes the next principal and remains readable after restart.
    const infraDetails = buildNavigatorInfrastructureFailureFact();
    sessionManager.appendMessage({
      role: "toolResult",
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId: "judge-infra",
      isError: true,
      content: [{ type: "text", text: "host failure" }],
      timestamp: Date.now(),
      details: infraDetails,
    } as never);
    const afterInfra = resolveLifecycleInvocationPrincipal(sessionManager.getEntries());
    assert.equal(afterInfra.resume, false, "infra failure completes the open principal");
    assert.notEqual(afterInfra.invocationId, nextId);
    await handlers.get("session_start")?.({}, ctx);
    const markersAfterInfra = roleSessionEntries.filter(
      (entry) => entry.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY,
    );
    assert.equal(markersAfterInfra.length, 3, "infra failure mints a fresh principal on restart");
    const afterInfraId = (markersAfterInfra[2]?.data as { invocationId?: string } | undefined)?.invocationId;
    assert.equal(isUuidV7(afterInfraId), true);
    assert.notEqual(afterInfraId, nextId);
    assert.notEqual(afterInfraId, markerId);
    assert.equal(attendanceInvocationId, afterInfraId);

    // Public Terminal settlement: nearest marker before terminal binds the completed invocation.
    const subjectKey = `${home}/.ak/work`;
    const sessionEntries = [
      { type: "session", id: sessionManager.getSessionId(), cwd: home },
      {
        type: "custom",
        customType: NAVIGATOR_INVOCATION_ENTRY,
        data: { invocationId: markerId, role: "judge", phase: null, subjectKey },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          isError: false,
          details: { judgeStatus: "converged" },
        },
      },
      {
        type: "custom_message",
        customType: "ak-navigator-attendance",
        message: {
          details: {
            version: 1,
            disposition: "recommendation",
            invocationId: markerId,
            role: "judge",
            phase: null,
            subjectKey,
            next: { role: "fixer", phase: "apply" },
            reason: "continue to fixer",
          },
        },
      },
    ];
    const fact = extractNavigatorFact(sessionEntries as never);
    assert.equal(fact.disposition, "recommendation");

    // Old principal attendance after a later completed invocation is rejected.
    const stale = extractNavigatorFact([
      {
        type: "custom",
        customType: NAVIGATOR_INVOCATION_ENTRY,
        data: { invocationId: markerId, role: "judge", phase: null, subjectKey },
      },
      {
        type: "custom",
        customType: NAVIGATOR_INVOCATION_ENTRY,
        data: { invocationId: nextId, role: "judge", phase: null, subjectKey },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: JUDGE_OUTPUT_TOOL_NAME,
          isError: false,
          details: { judgeStatus: "converged" },
        },
      },
      {
        type: "custom_message",
        customType: "ak-navigator-attendance",
        message: {
          details: {
            version: 1,
            disposition: "recommendation",
            invocationId: markerId,
            role: "judge",
            phase: null,
            subjectKey,
            next: { role: "fixer", phase: "apply" },
            reason: "stale",
          },
        },
      },
    ] as never);
    assert.equal(stale.disposition, "unavailable");
  });
});

test("healthy Navigator preparation survives mid-turn agent_settled for later accepted terminal", async () => {
  const { basename } = await import("node:path");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createRoleRuntimeExtension } = await import("../../src/role-runtime.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");
  const { JUDGE_OUTPUT_TOOL_NAME } = await import("../../src/package-contracts/judge-output.ts");

  await withActivationHome({ prefix: "ak-nav-survive-turn-" }, async ({ home }) => {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const emit = async (name: string, event: unknown, ctx: unknown) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };
    const pi = {
      registerFlag() {},
      getFlag(name: string) {
        return name === "ak-role" ? "judge" : undefined;
      },
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool() {},
      getAllTools() {
        return [];
      },
      setActiveTools() {},
      appendEntry() {},
      async sendMessage() {},
    };

    let settleCount = 0;
    let prepareCount = 0;
    let releasePrep!: () => void;
    const prepGate = new Promise<void>((resolve) => { releasePrep = resolve; });
    let prepStarted!: () => void;
    const started = new Promise<void>((resolve) => { prepStarted = resolve; });
    const events: Array<{ disposition?: string }> = [];

    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW",
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" }),
      loadNavigatorWorkContext: async () => ({
        subjectKey: "/repo/.ak/work/issues/11",
        subject: "issue 11",
        authority: "owner authority",
        subjectProvenance: "role_input" as const,
      }),
      createNavigatorAttendance: (options) => {
        const nav = createNavigatorAttendance({
          ...options,
          context: resolvePiContextAtCompositionRoot(options.context),
          modelSettingPath: join(home, "navigator-model.json"),
          loadSoul: async () => "route law",
          loadRoleHelp: async (role) => `Usage: ak-role ${role}`,
          createSession: async ({ tool }) => ({
            async prompt() {
              prepStarted();
              await prepGate;
              await tool.execute(
                "prep-1",
                {
                  candidates: [{
                    id: "judge-to-fixer",
                    matches: { role: "judge", phase: null, kind: "accepted" },
                    route: [{ role: "fixer", phase: "apply" }],
                    next: { role: "fixer", phase: "apply" },
                    reason: "apply the repair",
                    command: "Usage: ak-role fixer",
                  }],
                } as never,
                undefined,
                undefined,
                {} as never,
              );
            },
            appendEntry() {},
            entries: () => [],
            recordPointer: () => "/fixture/navigator-record",
            dispose() {},
          }),
          onEvent: async (event, report) => {
            events.push(event);
            await options.onEvent(event, report);
          },
        });
        const originalPrepare = nav.prepare.bind(nav);
        const originalSettle = nav.settle.bind(nav);
        return {
          ...nav,
          prepare() {
            prepareCount += 1;
            originalPrepare();
          },
          settle(settlement: never) {
            settleCount += 1;
            return originalSettle(settlement);
          },
        };
      },
    })(pi as never);

    await writeFile(join(home, "navigator-model.json"), JSON.stringify({ model: "provider/model" }));
    const sessionDir = join(home, ".ak-roles", "books", basename(home), "runs", "survive", "session");
    await mkdir(sessionDir, { recursive: true });
    const sessionManager = SessionManager.create(home, sessionDir);
    sessionManager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
    const ctx = { cwd: home, sessionManager, abort() {} };

    await emit("session_start", {}, ctx);
    assert.ok(prepareCount >= 1, "concrete role_input warms prepare at session_start");
    await started;

    // Mid-turn agent_settled must not discard the in-flight/healthy prepare (#162 coder grace class).
    await emit("agent_settled", {}, ctx);
    const settlesAfterMidTurn = settleCount;

    releasePrep();
    // Allow the in-flight prepare to finish accepting candidates before terminal.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await emit("tool_result", {
      toolName: JUDGE_OUTPUT_TOOL_NAME,
      toolCallId: "accepted-1",
      isError: false,
      content: [{ type: "text", text: "Judge verdict accepted" }],
      details: { judgeStatus: "converged" },
    }, ctx);
    await emit("agent_settled", {}, ctx);

    assert.equal(settlesAfterMidTurn, 0, "mid-turn agent_settled must not settle Navigator");
    assert.ok(settleCount >= 1, "accepted terminal must settle Navigator");
    assert.equal(events.some((event) => event.disposition === "recommendation"), true);
    assert.equal(events.some((event) => event.disposition === "unavailable"), false);
  });
});

