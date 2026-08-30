import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, validateToolArguments } from "@earendil-works/pi-ai";
import {
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  createNavigatorPrepareTool,
  decorateSettlementWithNavigation,
  formatNavigatorReport,
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  settlementNavigationFromEvent,
  writeNavigatorModelSetting,
  NAVIGATOR_TARGETS,
  type NavigatorCandidate,
  type NavigatorPreparationSession,
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  selectNavigatorCandidate,
  subjectPath,
} from "../../src/navigator-attendance.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import {
  loadNavigatorWorkContext,
  resolveNavigatorAuthorityMaterial,
} from "../../extensions/role-runtime.ts";
import { createHash } from "node:crypto";
import { seedGitRepository } from "../helpers/pi-test-harness.ts";
import {
  context,
  candidate,
  cleanupTempDir,
  sessionHarness,
  attendance,
  settleAnsweringRebind,
} from "../helpers/navigator-attendance-kit.ts";

test("Navigator preparation overlaps settlement, waits for the same call, and presents one typed event", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-attendance-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 1);
    assert.deepEqual(harness.retainedContext().currentRole, { role: "coder", phase: "apply" });
    assert.equal(harness.retainedContext().subject, "Fix issue 28");
    assert.equal(harness.retainedContext().authority, "owner decision");
    assert.equal(harness.retainedContext().subjectKey, "/repo/.ak/work/issues/28");
    let settled = false;
    const waiting = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" }).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    await harness.tool().execute("prepare", candidate(), undefined, undefined, {} as never);
    harness.release();
    await waiting;
    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "recommendation");
    assert.deepEqual(events[0].route, candidate().candidates[0]!.route);
    const invocation = harness.entries.find((entry: any) => entry.customType === "ak-navigator-invocation");
    const settlement = harness.entries.find((entry: any) => entry.customType === "ak-navigator-settlement");
    const route = harness.entries.find((entry: any) => entry.customType === "ak-navigator-route");
    assert.equal((invocation as any).data.invocationId, events[0].invocationId);
    assert.equal((settlement as any).data.invocationId, events[0].invocationId);
    assert.equal((route as any).data.invocationId, events[0].invocationId);
    assert.deepEqual(events[0].next, candidate().candidates[0]!.next);
    assert.equal(events[0].reason, candidate().candidates[0]!.reason);
    // Command is registry-rendered from next; model command prose is not authority.
    assert.equal(events[0].command, "ak-role reviewer");
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("rejected Navigator prepare consumes budget and correction succeeds in the same session", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-rejected-prepare-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    harness.rejectPrepare("root parameters must be an object");
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    while (harness.prompts() < 2 || harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("corrected-prepare", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 2);
    assert.equal(events[0]?.disposition, "recommendation");
  } finally { await cleanupTempDir(root); }
});

test("a duplicate Navigator prepare batch cannot publish its first provisional recommendation", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-duplicate-prepare-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("duplicate-first", candidate(), undefined, undefined, {} as never);
    await assert.rejects(
      harness.tool().execute("duplicate-second", candidate(), undefined, undefined, {} as never),
      /exactly one typed candidate batch/,
    );
    harness.entries.push({
      type: "message",
      message: { role: "assistant", content: [
        { type: "toolCall", id: "duplicate-first", name: NAVIGATOR_PREPARE_TOOL_NAME },
        { type: "toolCall", id: "duplicate-second", name: NAVIGATOR_PREPARE_TOOL_NAME },
      ] },
    });
    harness.entries.push({
      type: "message",
      message: { role: "toolResult", toolCallId: "duplicate-second", toolName: NAVIGATOR_PREPARE_TOOL_NAME, isError: true, content: [{ type: "text", text: "Navigator preparation must submit exactly one typed candidate batch" }] },
    });
    harness.release();
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("corrected-single", candidate({ reason: "Only the corrected batch is lawful." }), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.reason, "Only the corrected batch is lawful.");
  } finally { await cleanupTempDir(root); }
});

test("two rejected Navigator prepares settle typed no-advice with exact reasons and no third prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-rejected-exhaustion-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    harness.rejectPrepare("root rejection one", "root rejection two");
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 2, "budget exhaustion must not start a third prompt");
    assert.equal(events[0]?.disposition, "no-advice");
    const lifecycle = harness.entries.find((entry: any) => entry.customType === "ak-no-receipt-lifecycle") as any;
    assert.deepEqual(lifecycle?.data.rejectedReceipts, [
      { reason: "root rejection one", diagnosticAvailable: true },
      { reason: "root rejection two", diagnosticAvailable: true },
    ]);
    assert.equal(lifecycle?.data.terminalToolCalled, true);
  } finally { await cleanupTempDir(root); }
});

test("Navigator transport failure remains unavailable and does not enter rejected-prepare budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-prepare-transport-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    harness.failTransport("socket reset");
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 1);
    assert.equal(events[0]?.disposition, "unavailable");
    assert.equal(events[0]?.unavailableSource, "transport");
    assert.equal(harness.entries.some((entry: any) => entry.customType === "ak-no-receipt-lifecycle"), false);
  } finally { await cleanupTempDir(root); }
});

test("live help changes the next hint without a static template or fabricated task arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-help-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    let help = "Usage: pi --ak-role coder --ak-coder-phase <phase>";
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, async (role) => `${help} (${role})`);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.retainedContext().liveRoleHelp.find((entry: any) => entry.role === "coder").help.includes("ak-coder-phase"), true);
    await harness.tool().execute("prepare-1", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    help = "Usage: pi --ak-role coder --ak-coder-task <file>";
    nav.prepare();
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.retainedContext().liveRoleHelp.find((entry: any) => entry.role === "coder").help.includes("ak-coder-task"), true);
    assert.equal(harness.retainedContext().liveRoleHelp.some((entry: any) => entry.help.includes("/repo/task.md")), false);
    await harness.tool().execute("prepare-2", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("unchanged routes are omitted after a native-session route entry, while changed settings are reread", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-route-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/one" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare-1", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.ok(events[0].route);
    await writeFile(setting, JSON.stringify({ model: "provider/two" }));
    nav.prepare();
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare-2", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[1].route, undefined);
    assert.equal(harness.prompts(), 2);
    await writeFile(setting, JSON.stringify({ model: "provider/three" }));
    nav.prepare();
    while (harness.prompts() < 3) await new Promise<void>((resolve) => setImmediate(resolve));
    const original = candidate().candidates[0]!;
    const revised = { candidates: [{ id: original.id, matches: original.matches, reason: original.reason, route: [{ role: "coder" as const, phase: "apply" as const }, { role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }], next: { role: "fixer" as const, phase: "apply" as const } }] };
    await harness.tool().execute("prepare-3", revised, undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.deepEqual(events[2].route, revised.candidates[0]!.route);
    assert.deepEqual(harness.modelSettings, [
      { model: "provider/one", thinkingLevel: "off" },
      { model: "provider/two", thinkingLevel: "off" },
      { model: "provider/three", thinkingLevel: "off" },
    ]);
    assert.ok(harness.entries.some((entry: any) => entry.customType === "ak-navigator-route"));
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("typed owner-decision and role-infrastructure outcomes emit affirmative no-advice", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-no-advice-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    const owner = nav.settle({ kind: "human_decision", role: "coder", phase: "apply", status: "escalate" });
    await harness.tool().execute("no-advice-owner", candidate(), undefined, undefined, {} as never);
    harness.release();
    await owner;
    nav.prepare();
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    const infra = nav.settle({ kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
    await harness.tool().execute("no-advice-infra", candidate(), undefined, undefined, {} as never);
    harness.release();
    await infra;
    assert.equal(events.length, 2);
    assert.equal(events[0]?.disposition, "no-advice");
    assert.equal(typeof events[0]?.invocationId, "string");
    assert.ok(String(events[0]?.invocationId).length > 0);
    assert.equal(events[0]?.role, "coder");
    assert.equal(events[0]?.phase, "apply");
    assert.equal(typeof events[0]?.subjectKey, "string");
    assert.equal(events[1]?.disposition, "no-advice");
    // One attendance instance keeps one exact principal across settles.
    assert.equal(events[1]?.invocationId, events[0]?.invocationId);
    assert.equal(harness.prompts(), 2);
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("Navigator session creation failures become unavailable without rejecting settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-unavailable-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    for (const diagnostic of ["provider auth down", "session open failed with different wording"]) {
      const events: any[] = [];
      const nav = createNavigatorAttendance({
        context: context(),
        role: "coder",
        phase: "apply",
        subjectKey: "/repo/.ak/work/issues/28",
        subject: "Fix issue 28",
        authority: "owner decision",
        loadSoul: async () => "route judgment",
        loadRoleHelp: async () => "Usage: pi --ak-role coder --help",
        modelSettingPath: setting,
        createSession: async () => { throw new Error(diagnostic); },
        onEvent: async (event) => { events.push(event); },
      });
      nav.prepare();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "unavailable");
      assert.equal(events[0].unavailableSource, "session");
      assert.equal(events[0].unavailableCause, "session");
      assert.notEqual(events[0].unavailableReason, undefined);
    }
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("Navigator accepts only the audit-owned in-memory projection across all four seats", () => {
  const seats = [
    { role: "judge", phase: null, toolName: JUDGE_OUTPUT_TOOL_NAME },
    { role: "fixer", phase: "apply", toolName: FIXER_OUTPUT_TOOL_NAME },
    { role: "reviewer", phase: null, toolName: REVIEWER_OUTPUT_TOOL_NAME },
    { role: "doctor", phase: null, toolName: DOCTOR_OUTPUT_TOOL_NAME },
  ] as const;
  for (const seat of seats) {
    const projected = buildAuditEscalationResult({
      status: "escalate",
      conflicts: [`${seat.role} conflict`],
      decisionGate: { question: `${seat.role} question`, options: ["owner", "audit"] },
    }, { [seat.role]: "role output" });
    assert.deepEqual(
      publicNavigatorSettlement(seat.role, seat.phase, {
        toolName: seat.toolName,
        isError: false,
        details: projected,
      }),
      { kind: "human_decision", role: seat.role, phase: seat.phase, status: "audit_escalation" },
      seat.role,
    );
    // The same visible shape, including every audit-owned field/value, is
    // still only role-authored data after the object identity is copied.
    assert.notEqual(
      publicNavigatorSettlement(seat.role, seat.phase, {
        toolName: seat.toolName,
        isError: false,
        details: { ...projected },
      })?.kind,
      "human_decision",
      `${seat.role}: copied role-shaped details must not escalate Navigator`,
    );
    for (const forged of [
      { ...projected, status: "pass" },
      { ...projected, kind: "audit_escalation", auditDecisionGate: undefined },
      { ...projected, conflicts: ["wrong"] },
      { ...projected, conflicts: [...(projected.conflicts as readonly unknown[]), "duplicate"] },
      { ...projected, conflicts: [...(projected.conflicts as readonly unknown[])].reverse() },
    ]) {
      assert.notEqual(
        publicNavigatorSettlement(seat.role, seat.phase, {
          toolName: seat.toolName,
          isError: false,
          details: { ...forged },
        })?.kind,
        "human_decision",
        `${seat.role}: forged audit evidence must not escalate Navigator`,
      );
    }
  }
});

test("model settings are exact and typed settlement projection ignores prose and correctable errors", () => {
  assert.deepEqual(parseNavigatorModelSetting("openai-codex/gpt-5.6-luna:max"), { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" });
  assert.deepEqual(parseNavigatorModelSetting("provider/model"), { provider: "provider", model: "model", thinkingLevel: "off" });
  assert.throws(() => parseNavigatorModelSetting("provider/model:backup"));
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { message: "correctable schema wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: buildNavigatorInfrastructureFailureFact() }), { kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { terminal: "infrastructure_failure", message: "network wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("judge", null, { toolName: "ak_judge_output", isError: false, details: { judgeStatus: "escalate", report: "any wording" } }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("countersign", null, { toolName: "ak_countersign_output", isError: false, details: { countersignStatus: "escalate" } }), { kind: "human_decision", role: "countersign", phase: null, status: "escalate" });
  assert.notEqual(publicNavigatorSettlement("fixer", "apply", { toolName: "ak_fixer_output", isError: false, details: { kind: "audit_escalation", conflicts: ["authority"], auditDecisionGate: { question: "Which?", options: ["owner"] } } })?.kind, "human_decision");
  // selectNavigatorCandidate status membership is owned by the status-specific outrank table.
});

test("native session uses the saved model exactly and rejects unsupported thinking without fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-native-model-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    seedGitRepository(root);
    const faux = fauxProvider({ provider: "native-model", api: "native-model" });
    const model = faux.getModel();
    const setting = join(root, "navigator-model.json");
    await writeFile(setting, JSON.stringify({ model: `${model.provider}/${model.id}:max` }));
    const nativeContext = {
      cwd: root,
      modelRegistry: {
        find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
        getProvider: (provider: string) => provider === model.provider ? faux.provider : undefined,
        async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
      },
    } as never;
    const factory = createNativeNavigatorSessionFactory();
    const tool = createNavigatorPrepareTool(() => {});
    await assert.rejects(
      factory({ context: nativeContext, subject: join(root, "session"), tool }),
      (error: unknown) => error instanceof NavigatorUnavailableError
        && error.unavailableSource === "thinking"
        && error.unavailableCause === "thinking",
    );
    await writeFile(setting, JSON.stringify({ model: `${model.provider}/${model.id}` }));
    const session = await factory({ context: nativeContext, subject: join(root, "session"), tool });
    assert.equal(session.getThinkingLevel?.(), "off");
    session.dispose();
    await writeFile(setting, JSON.stringify({ model: "missing/provider" }));
    await assert.rejects(
      factory({ context: nativeContext, subject: join(root, "session"), tool }),
      (error: unknown) => error instanceof NavigatorUnavailableError
        && error.unavailableSource === "model"
        && error.unavailableCause === "model",
    );
  } catch (error) {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await cleanupTempDir(root, error);
    throw error;
  }
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await cleanupTempDir(root);
});

test("native provider stream seam classifies auth/quota/transport after setModel without message metadata oracle", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-native-stream-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    seedGitRepository(root);
    const cases = [
      { name: "auth", source: "auth" as const, status: 401, diagnostics: ["auth key unavailable", "login expired differently"] },
      { name: "quota", source: "quota" as const, status: 429, diagnostics: ["quota exhausted", "billing limit reached differently"] },
      { name: "transport", source: "transport" as const, diagnostics: ["transport unavailable", "socket reset differently"] },
    ] as const;
    for (const scenario of cases) {
      // One session per source; two diagnostics prove prose-independence without rebuilding native sessions.
      const faux = fauxProvider({ provider: `native-stream-${scenario.name}`, api: `native-stream-${scenario.name}` });
      const model = faux.getModel();
      const setting = join(root, "navigator-model.json");
      await writeFile(setting, JSON.stringify({ model: `${model.provider}/${model.id}` }));
      let currentDiagnostic: string = scenario.diagnostics[0]!;
      const observedCallbacks: number[] = [];
      const failingProvider = {
        ...faux.provider,
        stream(requestModel: typeof model, streamContext: { tools?: Array<{ name: string }> }, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
          const names = streamContext.tools?.map((tool) => tool.name) ?? [];
          if (!names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) return faux.provider.stream(requestModel, streamContext as never, options as never);
          const stream = createAssistantMessageEventStream();
          const human = scenario.source === "transport"
            ? {
              ...fauxAssistantMessage("", { stopReason: "error", errorMessage: currentDiagnostic }),
              diagnostics: [{
                type: "provider_transport_failure",
                timestamp: Date.now(),
                error: { message: currentDiagnostic, code: "transport_error" },
              }],
            }
            : fauxAssistantMessage("", { stopReason: "error", errorMessage: currentDiagnostic });
          queueMicrotask(() => {
            void (async () => {
              if ("status" in scenario) {
                await options?.onResponse?.({ status: scenario.status, headers: {} }, requestModel);
                observedCallbacks.push(scenario.status);
              }
              stream.push({ type: "start", partial: { ...human, content: [], stopReason: "pending" } });
              stream.push({ type: "error", reason: "error", error: human });
            })();
          });
          return stream;
        },
        streamSimple(requestModel: typeof model, streamContext: { tools?: Array<{ name: string }> }, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
          return this.stream(requestModel, streamContext, options);
        },
      };
      const nativeContext = {
        cwd: root,
        modelRegistry: {
          find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
          getProvider: (provider: string) => provider === model.provider ? failingProvider : undefined,
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
        },
      } as never;
      const factory = createNativeNavigatorSessionFactory();
      const tool = createNavigatorPrepareTool(() => {});
      const session = await factory({ context: nativeContext, subject: join(root, `session-${scenario.name}`), tool });
      await session.setModel?.(`${model.provider}/${model.id}`, "off");
      for (const diagnostic of scenario.diagnostics) {
        currentDiagnostic = diagnostic;
        observedCallbacks.length = 0;
        await session.prompt("prepare routes");
        assert.deepEqual(session.providerFailure?.(), { source: scenario.source, cause: scenario.source }, `${scenario.name}:${diagnostic}`);
        const assistant = [...session.entries()].reverse().find((entry: any) => entry?.type === "message" && entry?.message?.role === "assistant") as any;
        assert.equal(assistant?.message?.errorMessage, diagnostic, `${scenario.name}:${diagnostic}`);
        // Classification still comes from onResponse/diagnostics — not statusCode as oracle.
        // Held upstream status remains on the durable session message when the provider supplied it.
        if ("status" in scenario) {
          assert.equal(assistant?.message?.statusCode, scenario.status, `${scenario.name}:${diagnostic}`);
          assert.deepEqual(observedCallbacks, [scenario.status], `${scenario.name}:${diagnostic}`);
        } else {
          assert.equal(assistant?.message?.statusCode, undefined, `${scenario.name}:${diagnostic}`);
        }
        assert.equal(assistant?.message?.navigatorFailure, undefined, `${scenario.name}:${diagnostic}`);
      }
      session.dispose();
    }
  } catch (error) {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await cleanupTempDir(root, error);
    throw error;
  }
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await cleanupTempDir(root);
});
























