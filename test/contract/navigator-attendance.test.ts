import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  navigatorSessionDirectory,
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  selectNavigatorCandidate,
  subjectPath,
} from "../../src/navigator-attendance.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { activationBookDirectory, resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
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

function context() {
  return {
    sessionManager: {
      getSessionId: () => "invocation",
    },
    cwd: "/repo",
  } as never;
}

function candidate(overrides: Partial<NavigatorCandidate> = {}) {
  const base: NavigatorCandidate = {
    id: "small-fix",
    matches: { role: "coder", phase: "apply" as const, kind: "accepted" as const, statuses: ["completed", "refused"] },
    route: [{ role: "coder" as const, phase: "apply" as const }, { role: "reviewer" as const, phase: null }, { role: "judge" as const, phase: null }],
    next: { role: "reviewer" as const, phase: null },
    reason: "The implementation is ready for an independent review.",
  };
  return {
    candidates: [{
      ...base,
      ...overrides,
      matches: { ...base.matches!, ...(overrides.matches ?? {}) },
    }],
  };
}

async function cleanupTempDir(root: string, primaryFailure?: unknown): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cleanupFailure) {
    if (primaryFailure === undefined) throw cleanupFailure;
    throw new AggregateError([primaryFailure, cleanupFailure], "Test failed and cleanup failed", { cause: primaryFailure });
  }
}

function sessionHarness() {
  const entries: unknown[] = [];
  const modelSettings: Array<{ model: string; thinkingLevel: string }> = [];
  let tool: any;
  let prompts = 0;
  let releasePrompt: (() => void) | undefined;
  const session: NavigatorPreparationSession = {
    async prompt(_text) {
      prompts += 1;
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
    },
    appendEntry(_type, data) { entries.push({ type: "custom", customType: _type, data }); },
    entries: () => entries,
    async setModel(model, thinkingLevel) { modelSettings.push({ model, thinkingLevel }); },
    dispose() {},
  };
  return {
    factory: async ({ tool: nextTool }: { tool: any }) => { tool = nextTool; return session; },
    tool: () => tool,
    release: () => releasePrompt?.(),
    prompts: () => prompts,
    /** Production-retained typed context fact (ak-navigator-context), not a prompt metadata channel. */
    retainedContext: () => {
      const entry = [...entries].reverse().find((item: any) => item?.customType === "ak-navigator-context");
      return (entry as { data?: unknown } | undefined)?.data as any;
    },
    entries,
    modelSettings,
  };
}

async function attendance(path: string, harness: ReturnType<typeof sessionHarness>, events: any[], loadRoleHelp: (role: string) => Promise<string> = async (role) => `pi --ak-role ${role} --help`) {
  return createNavigatorAttendance({
    context: context(), role: "coder", phase: "apply", subjectKey: "/repo/.ak/work/issues/28", sessionDir: "/repo/.ak/work/issues/28/runs/navigator/session",
    subject: "Fix issue 28", authority: "owner decision",
    loadSoul: async () => "route judgment",
    loadRoutePlaybook: async () => "arbitrary advisory prose",
    loadRoleHelp,
    createSession: harness.factory,
    modelSettingPath: path,
    onEvent: async (event) => { events.push(event); },
  });
}

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
        sessionDir: "/repo/.ak/work/issues/28/runs/navigator",
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
  assert.notEqual(publicNavigatorSettlement("fixer", "apply", { toolName: "ak_fixer_output", isError: false, details: { kind: "audit_escalation", conflicts: ["authority"], auditDecisionGate: { question: "Which?", options: ["owner"] } } })?.kind, "human_decision");
  // selectNavigatorCandidate status membership is owned by the status-specific outrank table.
});

test("native session uses the saved model exactly and rejects unsupported thinking without fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-native-model-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
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
      factory({ context: nativeContext, sessionDir: join(root, "session"), tool }),
      (error: unknown) => error instanceof NavigatorUnavailableError
        && error.unavailableSource === "thinking"
        && error.unavailableCause === "thinking",
    );
    await writeFile(setting, JSON.stringify({ model: `${model.provider}/${model.id}` }));
    const session = await factory({ context: nativeContext, sessionDir: join(root, "session"), tool });
    assert.equal(session.getThinkingLevel?.(), "off");
    session.dispose();
    await writeFile(setting, JSON.stringify({ model: "missing/provider" }));
    await assert.rejects(
      factory({ context: nativeContext, sessionDir: join(root, "session"), tool }),
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
      const session = await factory({ context: nativeContext, sessionDir: join(root, `session-${scenario.name}`), tool });
      await session.setModel?.(`${model.provider}/${model.id}`, "off");
      for (const diagnostic of scenario.diagnostics) {
        currentDiagnostic = diagnostic;
        observedCallbacks.length = 0;
        await session.prompt("prepare routes");
        assert.deepEqual(session.providerFailure?.(), { source: scenario.source, cause: scenario.source }, `${scenario.name}:${diagnostic}`);
        const assistant = [...session.entries()].reverse().find((entry: any) => entry?.type === "message" && entry?.message?.role === "assistant") as any;
        assert.equal(assistant?.message?.errorMessage, diagnostic, `${scenario.name}:${diagnostic}`);
        assert.equal(assistant?.message?.statusCode, undefined, `${scenario.name}:${diagnostic}`);
        assert.equal(assistant?.message?.code, undefined, `${scenario.name}:${diagnostic}`);
        assert.equal(assistant?.message?.navigatorFailure, undefined, `${scenario.name}:${diagnostic}`);
        if ("status" in scenario) {
          assert.deepEqual(observedCallbacks, [scenario.status], `${scenario.name}:${diagnostic}`);
        }
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

test("native provider stream seam resets per call and classifies terminal-less completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-native-reset-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;

    // Sequential contamination: quota then synchronous setup transport through factory → setModel → prompt.
    {
      const faux = fauxProvider({ provider: "native-reset-sync", api: "native-reset-sync" });
      const model = faux.getModel();
      await writeFile(join(root, "navigator-model.json"), JSON.stringify({ model: `${model.provider}/${model.id}` }));
      let calls = 0;
      const provider = {
        ...faux.provider,
        stream(requestModel: typeof model, streamContext: { tools?: Array<{ name: string }> }, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
          const names = streamContext.tools?.map((tool) => tool.name) ?? [];
          if (!names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) return faux.provider.stream(requestModel, streamContext as never, options as never);
          calls += 1;
          if (calls === 1) {
            const stream = createAssistantMessageEventStream();
            const human = fauxAssistantMessage("", { stopReason: "error", errorMessage: "opaque quota wording" });
            queueMicrotask(() => {
              void (async () => {
                await options?.onResponse?.({ status: 429, headers: {} }, requestModel);
                stream.push({ type: "error", reason: "error", error: human });
              })();
            });
            return stream;
          }
          throw new Error("second setup transport");
        },
        streamSimple(requestModel: typeof model, streamContext: { tools?: Array<{ name: string }> }, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
          return this.stream(requestModel, streamContext, options);
        },
      };
      const nativeContext = {
        cwd: root,
        modelRegistry: {
          find: (providerName: string, id: string) => providerName === model.provider && id === model.id ? model : undefined,
          getProvider: (providerName: string) => providerName === model.provider ? provider : undefined,
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
        },
      } as never;
      const session = await createNativeNavigatorSessionFactory()({
        context: nativeContext,
        sessionDir: join(root, "session-reset"),
        tool: createNavigatorPrepareTool(() => {}),
      });
      await session.setModel?.(`${model.provider}/${model.id}`, "off");
      await session.prompt("first");
      assert.deepEqual(session.providerFailure?.(), { source: "quota", cause: "quota" });
      await session.setModel?.(`${model.provider}/${model.id}`, "off");
      await session.prompt("second");
      assert.deepEqual(session.providerFailure?.(), { source: "transport", cause: "transport" });
      assert.equal(calls, 2);
      session.dispose();
    }

    // Terminal-less completion must classify no-response transport without hanging on result().
    {
      const faux = fauxProvider({ provider: "native-no-terminal", api: "native-no-terminal" });
      const model = faux.getModel();
      await writeFile(join(root, "navigator-model.json"), JSON.stringify({ model: `${model.provider}/${model.id}` }));
      const provider = {
        ...faux.provider,
        stream() {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => stream.end());
          return stream;
        },
        streamSimple() {
          return this.stream();
        },
      };
      const nativeContext = {
        cwd: root,
        modelRegistry: {
          find: (providerName: string, id: string) => providerName === model.provider && id === model.id ? model : undefined,
          getProvider: (providerName: string) => providerName === model.provider ? provider : undefined,
          async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "offline" }; },
        },
      } as never;
      const session = await createNativeNavigatorSessionFactory()({
        context: nativeContext,
        sessionDir: join(root, "session-no-terminal"),
        tool: createNavigatorPrepareTool(() => {}),
      });
      await session.setModel?.(`${model.provider}/${model.id}`, "off");
      const outcome = await Promise.race([
        session.prompt("no terminal").then(() => "resolved" as const, () => "rejected" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
      ]);
      assert.equal(outcome, "resolved");
      assert.deepEqual(session.providerFailure?.(), { source: "transport", cause: "transport" });
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

test("persistent model edits are immediate and have no fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-model-setting-"));
  try {
    const path = join(root, "navigator-model.json");
    assert.equal(await readNavigatorModelSetting(path), NAVIGATOR_DEFAULT_MODEL);
    const started = Date.now();
    await writeNavigatorModelSetting("provider/one:max", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/one:max");
    await writeNavigatorModelSetting("provider/two", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/two");
    assert.equal(Date.now() - started < 5000, true);
    await writeFile(path, JSON.stringify({ model: "provider/one:backup" }));
    const invalid = await readNavigatorModelSetting(path);
    assert.throws(() => parseNavigatorModelSetting(invalid));
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("future arrival is typed and presentation-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-arrival-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    await nav.settle({ kind: "arrival", role: "lander", phase: null, message: "抵达" });
    assert.equal(events[0]?.disposition, "arrival");
    assert.equal(events[0]?.arrivalMessage, "抵达");
    assert.equal(formatNavigatorReport({ disposition: "arrival", arrivalMessage: "抵达" }), "抵达");
    assert.equal(harness.prompts(), 0);
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("settlement decoration carries recommendation only; unavailable and no-advice stay absent", () => {
  const base = {
    content: [{ type: "text" as const, text: "Judge verdict accepted" }],
    details: { judgeStatus: "converged" },
  };
  const recommendationEvent = {
    version: 1 as const,
    disposition: "recommendation" as const,
    invocationId: "i1",
    role: "judge",
    phase: null,
    subjectKey: "/repo",
    route: [{ role: "judge" as const, phase: null }, { role: "reviewer" as const, phase: null }],
    next: { role: "reviewer" as const, phase: null },
    reason: "needs review",
    command: "Usage: pi --ak-role reviewer --help",
  };
  const decorated = decorateSettlementWithNavigation(base, {
    event: recommendationEvent,
    report: {
      disposition: "recommendation",
      route: recommendationEvent.route,
      next: recommendationEvent.next,
      reason: recommendationEvent.reason,
      command: recommendationEvent.command,
    },
  });
  assert.ok(decorated);
  // Receipt details remain contract-pure (same reference / deep-equal shape).
  assert.equal(decorated.details, base.details);
  assert.deepEqual(decorated.details, { judgeStatus: "converged" });
  const text = (decorated.content[0] as { text: string }).text;
  assert.equal(text.includes(recommendationEvent.reason), true);
  assert.equal(text.includes(recommendationEvent.command), true);
  assert.deepEqual(settlementNavigationFromEvent(recommendationEvent), {
    disposition: "recommendation",
    route: recommendationEvent.route,
    next: recommendationEvent.next,
    reason: recommendationEvent.reason,
    command: recommendationEvent.command,
  });
  // Direction-only recommendation (no reason/command) still settles as navigation essentials.
  assert.deepEqual(
    settlementNavigationFromEvent({
      version: 1,
      disposition: "recommendation",
      invocationId: "i2",
      role: "judge",
      phase: null,
      subjectKey: "/repo",
      next: { role: "fixer", phase: "apply" },
    }),
    {
      disposition: "recommendation",
      next: { role: "fixer", phase: "apply" },
    },
  );
  assert.equal(
    decorateSettlementWithNavigation(base, {
      event: { ...recommendationEvent, disposition: "unavailable", unavailableReason: "x", unavailableSource: "model", unavailableCause: "model" },
      report: { disposition: "unavailable", unavailableReason: "x", unavailableSource: "model", unavailableCause: "model" },
    }),
    undefined,
  );
  assert.equal(decorateSettlementWithNavigation(base, undefined), undefined);
  assert.equal(
    decorateSettlementWithNavigation(base, {
      event: { ...recommendationEvent, disposition: "no-advice" },
      report: { disposition: "no-advice" },
    }),
    undefined,
  );
});

test("session placement is stable, colocated, and isolates ad hoc subjects", async () => {
  const repository = process.cwd();
  const base = { cwd: repository, sessionManager: { getSessionDir: () => "", getSessionId: () => "x" } } as never;
  const book = activationBookDirectory(resolveActivationLedgerHome(), resolveBookKeyFromGit(repository));
  const issue = subjectPath("/repo/.ak/work/issues/28/runs/one/session", "/repo");
  const relativeIssue = subjectPath(".ak/work/issues/28/runs/two/session", "/repo");
  assert.equal(issue, "/repo/.ak/work/issues/28");
  assert.equal(relativeIssue, issue);
  assert.equal(navigatorSessionDirectory(base, issue).startsWith(join(book, "navigator")), true);
  const issueVariant = navigatorSessionDirectory(base, `${issue}#ad-hoc-subject`);
  assert.equal(issueVariant.startsWith(join(book, "navigator")), true);
  assert.notEqual(issueVariant, navigatorSessionDirectory(base, `${issue}#other-subject`));
  const first = navigatorSessionDirectory(base, "/repo/task-a.md");
  const firstRelative = navigatorSessionDirectory(base, subjectPath("task-a.md", "/repo"));
  const second = navigatorSessionDirectory(base, "/repo/task-b.md");
  assert.equal(firstRelative, first);
  assert.notEqual(first, second);
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/coder/session", "/repo"), "/repo/.ak/work/ad-hoc");
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/reviewer/session", "/repo"), "/repo/.ak/work/ad-hoc");
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"), "/repo/.ak/work/ad-hoc");
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/reviewer/task.md", "/repo"), "/repo/.ak/work/ad-hoc");
  const adHocRoot = "/repo/.ak/work/ad-hoc";
  assert.equal(navigatorSubjectKey(adHocRoot, "same concrete task"), navigatorSubjectKey(adHocRoot, "same   concrete task"));
  assert.notEqual(navigatorSubjectKey(adHocRoot, "same concrete task"), navigatorSubjectKey(adHocRoot, "different task"));
  assert.equal(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"),
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/reviewer/task.md", "/repo"),
    "role-specific run folders must not split one ad-hoc subject",
  );
  assert.equal(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/other-task.md", "/repo"),
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/reviewer/task.md", "/repo"),
    "natural role-specific filenames remain one work subject",
  );
  assert.notEqual(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"),
    navigatorSubjectKeyForInput("/repo/.ak/work/other-ad-hoc", "/repo/.ak/work/other-ad-hoc/runs/reviewer/fix-packet.json", "/repo"),
    "distinct work roots remain isolated",
  );
  assert.equal(navigatorSubjectKey("/repo/task.md", "task text"), "/repo/task.md");
  assert.equal(first.startsWith(join(book, "navigator")), true);
  assert.equal(first.includes(join(".ak", "work", "navigator")), false);
  // Machine-ledger session transport is not work identity (ADR 0048).
  // Ordinary repo cwd with no explicit work root falls back to cwd/.ak/work,
  // same as empty/in-memory sessionDir — never the per-invocation ledger path.
  // Membership is path-semantic containment under the resolved package ledger home.
  const ledgerSession = join(
    resolveActivationLedgerHome(),
    "books",
    "repo",
    "issues",
    "28",
    "runs",
    "judge@src",
    "session",
  );
  assert.equal(subjectPath(ledgerSession, "/repo"), "/repo/.ak/work");
  assert.equal(subjectPath("", "/repo"), "/repo/.ak/work");
  assert.equal(
    subjectPath(ledgerSession, "/repo/.ak/work/issues/28"),
    "/repo/.ak/work/issues/28",
  );
  // Directory spelling alone is not ledger membership — consumer-repo path stays ordinary.
  const spellingOnlySession = "/repo/.ak-roles/books/repo/issues/28/runs/judge@src/session";
  assert.equal(
    subjectPath(spellingOnlySession, "/repo"),
    "/repo/.ak-roles/books/repo/issues/28",
  );
  // Physical identity: realpath asymmetry (macOS /var ↔ /private/var) must not
  // demote a ledger session into a non-issue subject (Navigator attendance flake class).
  await (async () => {
    const home = await mkdtemp(join(tmpdir(), "ak-nav-physical-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { realpathSync } = await import("node:fs");
      const issue = resolve(home, ".ak/work/issues/28");
      await mkdir(issue, { recursive: true });
      const session = resolve(
        home,
        ".ak-roles",
        "books",
        "h",
        "runs",
        "judge-navigator",
        "session",
      );
      await mkdir(session, { recursive: true });
      const realSession = realpathSync(session);
      // Mixed lexical/physical must still classify as ledger and keep issue subject.
      assert.equal(subjectPath(session, issue), issue);
      assert.equal(subjectPath(realSession, issue), issue);
      const lexicalPlacement = navigatorSessionDirectory(
        { cwd: repository, sessionManager: { getSessionDir: () => session } } as never,
      );
      const physicalPlacement = navigatorSessionDirectory(
        { cwd: repository, sessionManager: { getSessionDir: () => realSession } } as never,
      );
      assert.equal(physicalPlacement, lexicalPlacement);
      assert.equal(physicalPlacement.startsWith(join(activationBookDirectory(resolveActivationLedgerHome(), resolveBookKeyFromGit(repository)), "navigator")), true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  })();
  assert.equal(
    navigatorSessionDirectory(
      { cwd: repository, sessionManager: { getSessionDir: () => ledgerSession } } as never,
    ),
    navigatorSessionDirectory(
      { cwd: repository, sessionManager: { getSessionDir: () => "" } } as never,
      subjectPath("", repository),
    ),
  );
  // Typed provenance (absorbed from standalone provenance carrier).
  assert.equal(navigatorSubjectKey(adHocRoot, `work subject: ${adHocRoot}`, "placeholder"), adHocRoot);
  const legitimate = `work subject: ${adHocRoot} with real task bytes`;
  const hashed = navigatorSubjectKey(adHocRoot, legitimate, "role_input");
  assert.notEqual(hashed, adHocRoot);
  assert.equal(hashed, `${adHocRoot}#${createHash("sha256").update(legitimate.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32)}`);
  assert.equal(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "placeholder"), adHocRoot);
  assert.notEqual(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "user_prompt"), adHocRoot);
});

test("dispose during pending createSession drains the created session without prompt or assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-dispose-race-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let disposeCalls = 0;
    let promptCalls = 0;
    let setModelCalls = 0;
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(),
      role: "coder",
      phase: "apply",
      subjectKey: "/repo/.ak/work/issues/28",
      sessionDir: join(root, "session"),
      subject: "Fix issue 28",
      authority: "owner decision",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async () => "Usage: pi --ak-role coder --help",
      modelSettingPath: setting,
      createSession: async () => {
        await createGate;
        return {
          async prompt() { promptCalls += 1; },
          appendEntry() {},
          entries: () => [],
          async setModel() { setModelCalls += 1; },
          getThinkingLevel: () => "off",
          dispose() { disposeCalls += 1; },
        };
      },
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    while (!nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    nav.dispose();
    releaseCreate();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    // Allow the in-flight initializer to observe disposed and drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(promptCalls, 0, "disposed attendance must not prompt");
    assert.equal(setModelCalls, 0, "disposed attendance must not configure the late session");
    assert.equal(disposeCalls, 1, "created session must be disposed exactly once");
    assert.equal(events.some((event) => event.disposition === "recommendation"), false);
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("status-specific route candidates outrank generics regardless of declaration order", () => {
  const route = [{ role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }];
  const generic = candidate({
    id: "generic",
    matches: { role: "fixer", phase: "apply", kind: "accepted" },
    route,
    next: route[1]!,
    reason: "generic fallback",
  }).candidates[0]!;
  const unfinishedSpecific = candidate({
    id: "unfinished-specific",
    matches: { role: "fixer", phase: "apply", kind: "accepted", statuses: ["unfinished"] },
    route,
    next: route[0]!,
    reason: "finish the open class",
  }).candidates[0]!;
  const settlement = { kind: "accepted" as const, role: "fixer", phase: "apply" as const, status: "unfinished" };
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], settlement)?.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], settlement)?.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.id, "generic");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.id, "generic");
  // Statuses list membership (absorbed from model-settings carrier).
  const reviewerStatuses = candidate({
    matches: { role: "reviewer", phase: null, kind: "accepted", statuses: ["completed", "refused"] },
    route: [{ role: "judge", phase: null }],
    next: { role: "judge", phase: null },
  }).candidates;
  assert.equal(selectNavigatorCandidate(reviewerStatuses, { kind: "accepted", role: "reviewer", phase: null, status: "completed" })?.id, reviewerStatuses[0]!.id);
  assert.equal(selectNavigatorCandidate(reviewerStatuses, { kind: "accepted", role: "reviewer", phase: null, status: "refused" })?.id, reviewerStatuses[0]!.id);
});

test("resumed setModel and thinking failures preserve typed source and cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-resumed-cause-"));
  try {
    const setting = join(root, "model.json");
    const cases = [
      { name: "thinking", secondModel: "provider/model:max", source: "thinking" as const, fail: "thinking" as const },
      { name: "session", secondModel: "provider/model", source: "session" as const, fail: "session" as const },
    ] as const;
    for (const scenario of cases) {
      await writeFile(setting, JSON.stringify({ model: "provider/model" }));
      const events: any[] = [];
      let setModelCalls = 0;
      let created = false;
      const nav = createNavigatorAttendance({
        context: context(),
        role: "judge",
        phase: null,
        subjectKey: "/repo/.ak/work/issues/28",
        sessionDir: join(root, scenario.name),
        subject: "task",
        authority: "authority",
        loadSoul: async () => "route judgment",
        loadRoleHelp: async () => "help",
        modelSettingPath: setting,
        createSession: async ({ tool }) => {
          created = true;
          return {
            async prompt() {
              await tool.execute("prepare", {
                candidates: [{
                  id: "resume-route",
                  matches: { role: "judge", phase: null, kind: "accepted" },
                  route: [{ role: "judge", phase: null }, { role: "reviewer", phase: null }],
                  next: { role: "reviewer", phase: null },
                  reason: "resume path",
                  command: "Usage: pi --ak-role reviewer --help",
                }],
              }, undefined, undefined, {} as never);
            },
            appendEntry() {},
            entries: () => [],
            async setModel() {
              setModelCalls += 1;
              if (scenario.fail === "session" && setModelCalls > 1) {
                throw new Error("setModel blew up with untyped wording");
              }
            },
            getThinkingLevel: () => "off",
            dispose() {},
          };
        },
        onEvent: async (event) => { events.push(event); },
      });
      nav.prepare();
      await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
      assert.equal(created, true);
      assert.equal(events[0]?.disposition, "recommendation");
      await writeFile(setting, JSON.stringify({ model: scenario.secondModel }));
      nav.prepare();
      await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
      assert.equal(events[1]?.disposition, "unavailable", scenario.name);
      assert.equal(events[1]?.unavailableSource, scenario.source, scenario.name);
      assert.equal(events[1]?.unavailableCause, scenario.source, scenario.name);
    }
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("registry output tools are the contract-owned constants", () => {
  assert.deepEqual(
    NAVIGATOR_TARGETS.map(({ role }) => role),
    PACKAGED_ROLE_REGISTRY.map(({ role }) => role),
  );
  assert.deepEqual(
    PACKAGED_ROLE_REGISTRY.map(({ role, outputTool }) => ({ role, outputTool })),
    [
      { role: "judge", outputTool: JUDGE_OUTPUT_TOOL_NAME },
      { role: "fixer", outputTool: FIXER_OUTPUT_TOOL_NAME },
      { role: "coder", outputTool: CODER_OUTPUT_TOOL_NAME },
      { role: "reviewer", outputTool: REVIEWER_OUTPUT_TOOL_NAME },
      { role: "collector", outputTool: COLLECTOR_OUTPUT_TOOL },
      { role: "doctor", outputTool: DOCTOR_OUTPUT_TOOL_NAME },
      { role: "merger", outputTool: MERGER_OUTPUT_TOOL_NAME },
    ],
  );
  assert.equal(publicNavigatorSettlement("fixer", "apply", { toolName: FIXER_OUTPUT_TOOL_NAME, isError: false, details: { status: "unfinished" } })?.kind, "accepted");
});

test("role-input authority wins verbatim; files fall back; neither is honestly unavailable", async () => {
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
  assert.equal(resolveNavigatorAuthorityMaterial("packet authority\n", "file authority\n"), "packet authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial("packet authority\n", undefined), "packet authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial(undefined, "file authority\n"), "file authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial("   \n", "file authority\n"), "file authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial(undefined, undefined), undefined);
  assert.equal(resolveNavigatorAuthorityMaterial("", undefined), undefined);

  const root = await mkdtemp(join(tmpdir(), "navigator-input-authority-"));
  try {
    const workRoot = resolve(root, ".ak/work/issues/91");
    await mkdir(workRoot, { recursive: true });
    const packetPath = resolve(workRoot, "fix-packet.md");
    const packetBytes = "# Fix packet\n\nCourt-binding authority for issue 91.\n";
    await writeFile(packetPath, packetBytes, "utf8");

    const sessionCtx = (cwd: string, sessionDir: string) => ({
      cwd,
      sessionManager: { getSessionDir: () => sessionDir },
    }) as never;
    const fixerPi = { getFlag: (name: string) => name === "ak-fix-packet" ? packetPath : undefined };
    const noInputPi = { getFlag: () => undefined };
    const fixerCtx = sessionCtx(workRoot, resolve(workRoot, "runs/fixer/session"));
    const judgeCtx = sessionCtx(workRoot, resolve(workRoot, "runs/judge/session"));

    // 1) packet input, no work-root files → authority = input bytes
    const inputOnly = await loadNavigatorWorkContext(fixerPi, { context: fixerCtx, role: "fixer" });
    assert.equal(inputOnly.authority, packetBytes);
    assert.equal(inputOnly.subject, packetBytes);
    assert.equal(inputOnly.subjectProvenance, "role_input");

    // 2) both present → input wins
    await writeFile(resolve(workRoot, "authority.md"), "work-root file authority\n", "utf8");
    const both = await loadNavigatorWorkContext(fixerPi, { context: fixerCtx, role: "fixer" });
    assert.equal(both.authority, packetBytes);
    assert.notEqual(both.authority, "work-root file authority\n");

    // 3) valid input + unreadable/directory authority.md still succeeds verbatim (true short-circuit)
    await rm(resolve(workRoot, "authority.md"));
    await mkdir(resolve(workRoot, "authority.md"), { recursive: true });
    const withDirectoryAuthority = await loadNavigatorWorkContext(fixerPi, { context: fixerCtx, role: "fixer" });
    assert.equal(withDirectoryAuthority.authority, packetBytes);
    assert.equal(withDirectoryAuthority.subject, packetBytes);
    assert.equal(withDirectoryAuthority.subjectProvenance, "role_input");

    // 4) no input (judge with only -p) + files present → files still used (主刀 flow)
    await rm(resolve(workRoot, "authority.md"), { recursive: true, force: true });
    await writeFile(resolve(workRoot, "authority.md"), "work-root file authority\n", "utf8");
    const filesOnly = await loadNavigatorWorkContext(noInputPi, { context: judgeCtx, role: "judge" });
    assert.equal(filesOnly.authority, "work-root file authority\n");
    assert.equal(filesOnly.subjectProvenance, "placeholder");

    // 5) neither at session_start → soft placeholder (bare -p prompt arrives later)
    await rm(resolve(workRoot, "authority.md"));
    const neither = await loadNavigatorWorkContext(noInputPi, { context: judgeCtx, role: "judge" });
    assert.equal(neither.subjectProvenance, "placeholder");
    assert.equal(neither.authority, "");
    assert.equal("contextError" in neither, false);
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare tool accepts direction-only and broken ancillary shape once without retry", async () => {
  const accepted: unknown[] = [];
  const tool = createNavigatorPrepareTool((value) => { accepted.push(value); });

  // Direction-only v1 shape: usable next survives without route/matches/reason/command/ids.
  const directionOnly = {
    candidates: [{ next: { role: "fixer", phase: "apply" } }],
  };
  const first = await tool.execute("direction-only", directionOnly as never, undefined, undefined, {} as never);
  assert.equal(accepted.length, 1, "direction-only batch must be accepted");
  assert.equal((first as { terminate?: boolean }).terminate, true);

  // Broken route / next outside route / missing reason+command must not open a correction loop.
  const brokenAncillary = {
    candidates: [{
      id: "broken-route",
      matches: { role: "coder", phase: "apply", kind: "accepted" },
      route: [{ role: "coder", phase: "apply" }],
      next: { role: "reviewer", phase: null },
      command: "Usage: model prose must not gate acceptance",
    }],
  };
  const second = await tool.execute("broken-ancillary", brokenAncillary as never, undefined, undefined, {} as never);
  assert.equal(accepted.length, 2, "broken ancillary shape still accepted once");
  assert.equal((second as { terminate?: boolean }).terminate, true);
  assert.equal((second as { details?: { error?: string } }).details?.error, undefined);
});

test("prepare provider schema admits object-root nested malformation through real Tool validation", async () => {
  const accepted: unknown[] = [];
  const tool = createNavigatorPrepareTool((value) => { accepted.push(value); });
  // Production gate is pi-ai validateToolArguments against tool.parameters — not direct execute.
  // Nested advisory shape must never reject before the unique execute/normalize path.
  const payloads = [
    { name: "route:string", args: { candidates: [{ next: { role: "judge" }, route: "coder→judge" }] } },
    { name: "reason:number", args: { candidates: [{ next: { role: "judge" }, reason: 42 }] } },
    { name: "matches:string", args: { candidates: [{ next: { role: "judge" }, matches: "fixer" }] } },
    { name: "missing candidates", args: {} },
    { name: "candidates:string", args: { candidates: "malformed" } },
    { name: "candidates:[42]", args: { candidates: [42] } },
    { name: "next:string", args: { candidates: [{ next: "malformed" }] } },
  ] as const;
  for (const payload of payloads) {
    const validated = validateToolArguments(tool as never, {
      id: payload.name,
      name: tool.name,
      arguments: structuredClone(payload.args),
    } as never);
    const result = await tool.execute(payload.name, validated as never, undefined, undefined, {} as never);
    assert.equal((result as { terminate?: boolean }).terminate, true, `${payload.name} must terminate once`);
  }
  assert.equal(accepted.length, payloads.length, "every object-root payload reaches the unique execute sink exactly once");

  // Usable next survives nested malformation after real validate→execute→settle.
  const root = await mkdtemp(join(tmpdir(), "navigator-schema-gate-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      const malformed = validateToolArguments(harness.tool() as never, {
        id: "live-usable",
        name: NAVIGATOR_PREPARE_TOOL_NAME,
        arguments: {
          candidates: [{
            next: { role: "fixer", phase: "apply" },
            route: "not-an-array",
            matches: "not-an-object",
            reason: 7,
          }],
        },
      } as never);
      await harness.tool().execute("live-usable", malformed as never, undefined, undefined, {} as never);
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events[0]?.disposition, "recommendation");
      assert.deepEqual(events[0]?.next, { role: "fixer", phase: "apply" });
      assert.equal(events[0]?.command, "ak-role fixer apply");
    }

    // Nested malformation without usable next → honest typed unavailable (no retry loop).
    for (const [name, args] of [
      ["candidates-string", { candidates: "malformed" }],
      ["candidates-number-items", { candidates: [42] }],
      ["next-string", { candidates: [{ next: "malformed" }] }],
    ] as const) {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      const validated = validateToolArguments(harness.tool() as never, {
        id: name,
        name: NAVIGATOR_PREPARE_TOOL_NAME,
        arguments: structuredClone(args),
      } as never);
      await harness.tool().execute(name, validated as never, undefined, undefined, {} as never);
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events.length, 1, `${name} settles once`);
      assert.equal(events[0]?.disposition, "unavailable", `${name} has no usable next`);
      assert.equal(events[0]?.unavailableSource, "unknown");
      assert.equal(typeof events[0]?.unavailableReason, "string");
    }
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("direction-only prepare settles recommendation; missing next is honest unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-direction-only-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    // 1) usable next without route/reason/command/matches/id → recommendation
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.tool().execute(
        "direction-only",
        { candidates: [{ next: { role: "fixer", phase: "apply" } }] },
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "recommendation");
      assert.deepEqual(events[0].next, { role: "fixer", phase: "apply" });
      assert.equal(events[0].route, undefined);
      assert.equal(events[0].reason, undefined);
      assert.equal(events[0].command, "ak-role fixer apply");
    }

    // 2) next survives broken route + absent reason/command
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.tool().execute(
        "broken-route",
        {
          candidates: [{
            route: [{ role: "coder", phase: "apply" }],
            next: { role: "reviewer", phase: null },
          }],
        },
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events[0].disposition, "recommendation");
      assert.deepEqual(events[0].next, { role: "reviewer", phase: null });
      // Broken/historical route may normalize; next must not be downgraded.
      assert.notEqual(events[0].disposition, "unavailable");
    }

    // 3) accepted submission with no machine-usable next → honest unavailable, no invented direction
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.tool().execute(
        "no-next",
        { candidates: [{ reason: "still thinking", route: [{ role: "not-a-role", phase: null }] }] },
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "unavailable");
      assert.equal(events[0].next, undefined);
      assert.equal(events[0].unavailableSource, "unknown");
      assert.equal(events[0].unavailableCause, "unknown");
      assert.notEqual(events[0].unavailableReason, undefined);
    }
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("advice command derives phase token from registry metadata for every packaged role", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-command-registry-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    // Command ownership is registry phases on normalized next — no parallel role-name list.
    for (const entry of PACKAGED_ROLE_REGISTRY) {
      for (const phase of entry.phases) {
        const harness = sessionHarness();
        const events: any[] = [];
        const nav = await attendance(setting, harness, events);
        nav.prepare();
        while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
        await harness.tool().execute(
          `cmd-${entry.role}-${String(phase)}`,
          { candidates: [{ next: { role: entry.role, phase } }] },
          undefined,
          undefined,
          {} as never,
        );
        harness.release();
        await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
        assert.equal(events[0]?.disposition, "recommendation", entry.role);
        assert.deepEqual(events[0]?.next, { role: entry.role, phase });
        const expected = phase === null ? `ak-role ${entry.role}` : `ak-role ${entry.role} ${phase}`;
        assert.equal(events[0]?.command, expected, `${entry.role}/${String(phase)}`);
      }
    }
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("completed Fixer/Coder settlement does not invent next without model/authority direction", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-no-invented-route-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    async function settleEmptyAdvice(role: "fixer" | "coder", batch: unknown) {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = createNavigatorAttendance({
        context: context(), role, phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
        sessionDir: "/repo/.ak/work/issues/28/runs/navigator/session",
        subject: "work", authority: "owner decision",
        loadSoul: async () => "route judgment",
        loadRoleHelp: async (r) => `help ${r}`,
        createSession: harness.factory,
        modelSettingPath: setting,
        onEvent: async (event) => { events.push(event); },
      });
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      await harness.tool().execute("batch", batch as never, undefined, undefined, {} as never);
      harness.release();
      await nav.settle({ kind: "accepted", role, phase: "apply", status: "completed" });
      return events[0];
    }

    // Empty advice after completed Fixer → honest unavailable; never invent Judge/Reviewer.
    const fixerEmpty = await settleEmptyAdvice("fixer", { candidates: [] });
    assert.equal(fixerEmpty?.disposition, "unavailable");
    assert.equal(fixerEmpty?.next, undefined);
    assert.equal(fixerEmpty?.unavailableSource, "unknown");
    assert.equal(fixerEmpty?.unavailableCause, "unknown");
    assert.notEqual(fixerEmpty?.unavailableReason, undefined);
    assert.notEqual(fixerEmpty?.next?.role, "judge");
    assert.notEqual(fixerEmpty?.next?.role, "reviewer");

    // Empty advice after completed Coder → honest unavailable; never invent Reviewer.
    const coderEmpty = await settleEmptyAdvice("coder", {});
    assert.equal(coderEmpty?.disposition, "unavailable");
    assert.equal(coderEmpty?.next, undefined);
    assert.equal(coderEmpty?.unavailableSource, "unknown");
    assert.equal(coderEmpty?.unavailableCause, "unknown");
    assert.notEqual(coderEmpty?.unavailableReason, undefined);
    assert.notEqual(coderEmpty?.next?.role, "reviewer");

    // Explicit model next still settles as recommendation (no host default involved).
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(), role: "fixer", phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
      sessionDir: "/repo/.ak/work/issues/28/runs/navigator/session",
      subject: "work", authority: "Controlling authority names coder apply next.",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async (r) => `help ${r}`,
      createSession: harness.factory,
      modelSettingPath: setting,
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute(
      "explicit",
      { candidates: [{ next: { role: "coder", phase: "apply" }, reason: "authority names coder apply next" }] },
      undefined,
      undefined,
      {} as never,
    );
    harness.release();
    await nav.settle({ kind: "accepted", role: "fixer", phase: "apply", status: "completed" });
    assert.equal(events[0]?.disposition, "recommendation");
    assert.deepEqual(events[0]?.next, { role: "coder", phase: "apply" });
  } catch (error) {
    await cleanupTempDir(root, error);
    throw error;
  }
  await cleanupTempDir(root);
});

test("empty authority at prepare is honest context unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-empty-authority-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(),
      role: "judge",
      phase: null,
      subjectKey: "/repo/.ak/work",
      sessionDir: join(root, "navigator"),
      subject: "work subject: /repo/.ak/work",
      authority: "",
      loadSoul: async () => "route law",
      loadRoleHelp: async (role) => `Usage: ak-role ${role}`,
      modelSettingPath: setting,
      createSession: async () => {
        throw new Error("session must not open without authority");
      },
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "unavailable");
    assert.equal(events[0].unavailableSource, "context");
    assert.equal(events[0].unavailableCause, "context");
    assert.equal(events[0].next, undefined);
    assert.notEqual(events[0].unavailableReason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public admitted-request projects typed subject/authority; missing/malformed stay source=context", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-admitted-request-"));
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    const runDir = join(root, "run-public-judge");
    await mkdir(runDir, { recursive: true });
    const sessionDir = join(runDir, "session");
    await mkdir(sessionDir, { recursive: true });
    const prose = "Canonical nonblank prose Judge request for navigation.";
    await writeFile(
      join(runDir, "admitted-request.json"),
      JSON.stringify({
        role: "judge",
        runId: "run-public-1",
        instruction: prose,
        instructionEmpty: false,
        attachments: [],
      }),
      "utf8",
    );

    process.env.AK_ROLE_RUN_DIR = runDir;
    const judgePi = { getFlag: () => undefined };
    const judgeCtx = {
      cwd: root,
      sessionManager: { getSessionDir: () => sessionDir },
    } as never;

    const loaded = await loadNavigatorWorkContext(judgePi, { context: judgeCtx, role: "judge" });
    assert.equal(loaded.subject, prose);
    assert.equal(loaded.authority, prose);
    assert.equal(loaded.subjectProvenance, "role_input");
    assert.ok(loaded.subjectKey.length > 0);

    // Missing admitted request → typed context unavailable (not model/session/transport).
    process.env.AK_ROLE_RUN_DIR = join(root, "missing-run");
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx, role: "judge" }),
      (error: unknown) =>
        error instanceof NavigatorUnavailableError &&
        error.unavailableSource === "context" &&
        error.unavailableCause === "context",
    );

    // Malformed admitted request JSON → same context classification.
    const badRun = join(root, "bad-run");
    await mkdir(badRun, { recursive: true });
    await writeFile(join(badRun, "admitted-request.json"), "{not-json", "utf8");
    process.env.AK_ROLE_RUN_DIR = badRun;
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx, role: "judge" }),
      (error: unknown) =>
        error instanceof NavigatorUnavailableError && error.unavailableSource === "context",
    );

    // Structurally invalid admitted request (wrong role) → context unavailable.
    const wrongRoleRun = join(root, "wrong-role-run");
    await mkdir(wrongRoleRun, { recursive: true });
    await writeFile(
      join(wrongRoleRun, "admitted-request.json"),
      JSON.stringify({
        role: "fixer",
        instruction: prose,
        instructionEmpty: false,
        attachments: [],
      }),
      "utf8",
    );
    process.env.AK_ROLE_RUN_DIR = wrongRoleRun;
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx, role: "judge" }),
      (error: unknown) =>
        error instanceof NavigatorUnavailableError && error.unavailableSource === "context",
    );

    // Empty public request keeps placeholder work context (no invented task prose).
    const emptyRun = join(root, "empty-run");
    await mkdir(emptyRun, { recursive: true });
    await writeFile(
      join(emptyRun, "admitted-request.json"),
      JSON.stringify({
        role: "judge",
        instruction: "",
        instructionEmpty: true,
        attachments: [],
      }),
      "utf8",
    );
    process.env.AK_ROLE_RUN_DIR = emptyRun;
    const empty = await loadNavigatorWorkContext(judgePi, { context: judgeCtx, role: "judge" });
    assert.equal(empty.subjectProvenance, "placeholder");
    assert.equal(empty.authority, "");
    assert.equal(empty.subject.includes(prose), false);
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("role-runtime passes admitted-request subject/authority into Navigator attendance", async () => {
  const { basename } = await import("node:path");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createRoleRuntimeExtension } = await import("../../src/role-runtime.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");

  const root = await mkdtemp(join(tmpdir(), "navigator-admitted-attendance-"));
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    const runDir = join(root, "run-dir");
    await mkdir(runDir, { recursive: true });
    const prose = "Admitted instruction prose observed by Navigator attendance.";
    await writeFile(
      join(runDir, "admitted-request.json"),
      JSON.stringify({
        role: "judge",
        instruction: prose,
        instructionEmpty: false,
        attachments: [],
      }),
      "utf8",
    );
    process.env.AK_ROLE_RUN_DIR = runDir;

    await withActivationHome({ prefix: "ak-nav-admitted-" }, async ({ home }) => {
      let observed: { subject?: string; authority?: string; subjectKey?: string } | undefined;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
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
        appendEntry(customType: string, data?: unknown) {
          appendedEntries.push({ customType, data });
        },
      };

      createRoleRuntimeExtension({
        loadJudgeSoul: async () => "JUDGE LAW",
        transcriptFromContext: () => "",
        auditSoulCompliance: async () => ({ status: "pass" }),
        loadNavigatorWorkContext: (options) => loadNavigatorWorkContext(pi as never, options),
        createNavigatorAttendance: (options) => {
          observed = {
            subject: options.subject,
            authority: options.authority,
            subjectKey: options.subjectKey,
          };
          return {
            prepare() {},
            setWorkContext() {},
            warmHelp() {},
            isPreparing: () => false,
            settle: async () => {},
            dispose() {},
          };
        },
      })(pi as never);

      const sessionDir = join(
        home,
        ".ak-roles",
        "books",
        basename(home),
        "runs",
        "judge-admitted",
        "session",
      );
      await mkdir(sessionDir, { recursive: true });
      const sessionManager = SessionManager.create(home, sessionDir);
      await handlers.get("session_start")?.({}, {
        cwd: home,
        sessionManager,
        abort() {},
      });

      assert.ok(observed, "Navigator attendance must be constructed");
      assert.equal(observed.subject, prose);
      assert.equal(observed.authority, prose);
      assert.ok(String(observed.subjectKey).length > 0);
    });
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    await rm(root, { recursive: true, force: true });
  }
});

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

      // Typed negative regressions: missing / non-boolean / zero / contradictory / extra-key infra fail closed.
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
      assert.equal(isDurablePackagedRoleTerminalResult(extraKeyInfraMsg), false, `${entry.role}:${String(phase)}:extra-key-infra`);
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
      assert.equal(
        publicNavigatorSettlement(entry.role, phase, extraKeyInfraMsg),
        undefined,
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
          sessionDir: join(home, "navigator-session"),
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

test("bare developer prompt recovers Navigator work context poisoned at session_start", async () => {
  const { basename } = await import("node:path");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createRoleRuntimeExtension } = await import("../../src/role-runtime.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");

  await withActivationHome({ prefix: "ak-nav-prompt-recover-" }, async ({ home }) => {
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
    };

    let latestContext: {
      subject?: string;
      authority?: string;
      subjectProvenance?: string;
      contextError?: unknown;
    } = {};
    let prepareCalls = 0;
    const setContexts: Array<Record<string, unknown>> = [];

    createRoleRuntimeExtension({
      loadJudgeSoul: async () => "JUDGE LAW",
      transcriptFromContext: () => "",
      auditSoulCompliance: async () => ({ status: "pass" }),
      // Production soft miss: session_start has no materials yet (no throw/poison).
      loadNavigatorWorkContext: async () => ({
        subjectKey: join(home, ".ak/work"),
        subject: `work subject: ${join(home, ".ak/work")}`,
        authority: "",
        subjectProvenance: "placeholder" as const,
      }),
      createNavigatorAttendance: (options) => {
        latestContext = {
          subject: options.subject,
          authority: options.authority,
          subjectProvenance: "placeholder",
          contextError: options.contextError,
        };
        return {
          prepare() {
            prepareCalls += 1;
          },
          setWorkContext(next: {
            subject: string;
            authority: string;
            subjectProvenance: string;
            contextError?: unknown;
          }) {
            setContexts.push({ ...next });
            latestContext = {
              subject: next.subject,
              authority: next.authority,
              subjectProvenance: next.subjectProvenance,
              contextError: next.contextError,
            };
          },
          warmHelp() {},
          isPreparing: () => false,
          settle: async () => {},
          dispose() {},
        };
      },
    })(pi as never);

    const sessionDir = join(
      home,
      ".ak-roles",
      "books",
      basename(home),
      "runs",
      "judge-bare-prompt",
      "session",
    );
    await mkdir(sessionDir, { recursive: true });
    const sessionManager = SessionManager.create(home, sessionDir);
    const ctx = { cwd: home, sessionManager, abort() {} };
    await emit("session_start", {}, ctx);

    assert.equal(latestContext.contextError, undefined, "soft miss must not install contextError");
    assert.equal(latestContext.authority, "");
    assert.equal(prepareCalls, 0, "placeholder context must not warm-prepare");

    const prompt = "Adjudicate the attached materials for issue 11 developer seam.";
    await emit("before_agent_start", { systemPrompt: "BASE", prompt }, ctx);

    assert.equal(latestContext.subject, prompt);
    assert.equal(latestContext.authority, prompt);
    assert.equal(latestContext.subjectProvenance, "user_prompt");
    assert.equal(prepareCalls, 1, "recovered concrete context must prepare");
    assert.ok(setContexts.length >= 1);
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
          sessionDir: join(home, "navigator-session"),
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
