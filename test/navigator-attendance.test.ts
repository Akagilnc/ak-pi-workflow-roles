import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  createNavigatorPrepareTool,
  formatNavigatorReport,
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
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
} from "../src/navigator-attendance.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../src/package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../src/merger-contracts.ts";
import { PACKAGED_ROLE_REGISTRY } from "../src/packaged-role-registry.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../src/role-runtime.ts";
import { navigatorAuthorityFromRoleInput } from "../extensions/role-runtime.ts";
import { createHash } from "node:crypto";

function context() {
  return {
    sessionManager: { getSessionId: () => "invocation" },
    cwd: "/repo",
  } as never;
}

function candidate() {
  return {
    candidates: [{
      id: "small-fix",
      matches: { role: "coder", phase: "apply" as const, kind: "accepted" as const, statuses: ["completed", "refused"] },
      route: [{ role: "coder" as const, phase: "apply" as const }, { role: "reviewer" as const, phase: null }, { role: "judge" as const, phase: null }],
      next: { role: "reviewer" as const, phase: null },
      reason: "The implementation is ready for an independent review.",
      command: "Usage: pi --ak-role reviewer --help",
    }],
  };
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
    assert.equal(formatNavigatorReport({ disposition: "recommendation", route: events[0].route, next: events[0].next, reason: events[0].reason, command: events[0].command }).includes(events[0].command), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    const revised = { candidates: [{ id: original.id, matches: original.matches, reason: original.reason, command: original.command, route: [{ role: "coder" as const, phase: "apply" as const }, { role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }], next: { role: "fixer" as const, phase: "apply" as const } }] };
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed owner-decision and role-infrastructure outcomes remain silent", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigator-silence-"));
  try {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    const owner = nav.settle({ kind: "human_decision", role: "coder", phase: "apply", status: "escalate" });
    await harness.tool().execute("silent-owner", candidate(), undefined, undefined, {} as never);
    harness.release();
    await owner;
    nav.prepare();
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    const infra = nav.settle({ kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
    await harness.tool().execute("silent-infra", candidate(), undefined, undefined, {} as never);
    harness.release();
    await infra;
    assert.deepEqual(events, []);
    assert.equal(harness.prompts(), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  } finally {
    await rm(root, { recursive: true, force: true });
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
  assert.deepEqual(publicNavigatorSettlement("fixer", "apply", { toolName: "ak_fixer_output", isError: false, details: { kind: "audit_escalation", conflicts: ["authority"], decisionGate: { question: "Which?", options: ["owner"] } } }), { kind: "human_decision", role: "fixer", phase: "apply", status: "audit_escalation" });
  const route = [{ role: "judge" as const, phase: null }];
  const source = candidate().candidates[0]!;
  const candidates = [{ id: source.id, matches: { role: "reviewer", phase: null, kind: "accepted" as const, statuses: ["completed", "refused"] }, route, next: route[0]!, reason: source.reason, command: source.command }];
  assert.equal(selectNavigatorCandidate(candidates, { kind: "accepted", role: "reviewer", phase: null, status: "completed" })?.id, candidates[0]!.id);
  assert.equal(selectNavigatorCandidate(candidates, { kind: "accepted", role: "reviewer", phase: null, status: "refused" })?.id, candidates[0]!.id);
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
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
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
      for (const diagnostic of scenario.diagnostics) {
        const faux = fauxProvider({ provider: `native-stream-${scenario.name}`, api: `native-stream-${scenario.name}` });
        const model = faux.getModel();
        const setting = join(root, "navigator-model.json");
        await writeFile(setting, JSON.stringify({ model: `${model.provider}/${model.id}` }));
        const observedCallbacks: number[] = [];
        const failingProvider = {
          ...faux.provider,
          stream(requestModel: typeof model, streamContext: { tools?: Array<{ name: string }> }, options?: { onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof requestModel) => void | Promise<void> }) {
            const names = streamContext.tools?.map((tool) => tool.name) ?? [];
            if (!names.includes(NAVIGATOR_PREPARE_TOOL_NAME)) return faux.provider.stream(requestModel, streamContext as never, options as never);
            const stream = createAssistantMessageEventStream();
            const human = scenario.source === "transport"
              ? {
                ...fauxAssistantMessage("", { stopReason: "error", errorMessage: diagnostic }),
                diagnostics: [{
                  type: "provider_transport_failure",
                  timestamp: Date.now(),
                  error: { message: diagnostic, code: "transport_error" },
                }],
              }
              : fauxAssistantMessage("", { stopReason: "error", errorMessage: diagnostic });
            queueMicrotask(() => {
              void (async () => {
                if ("status" in scenario) {
                  // Contract path: typed ProviderResponse.status via StreamOptions.onResponse.
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
        const session = await factory({ context: nativeContext, sessionDir: join(root, `session-${scenario.name}-${diagnostic.length}`), tool });
        // Production order: setModel replaces the registered provider before prompt.
        await session.setModel?.(`${model.provider}/${model.id}`, "off");
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
        session.dispose();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
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
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session placement is stable, colocated, and isolates ad hoc subjects", () => {
  const base = { cwd: "/repo", sessionManager: { getSessionDir: () => "", getSessionId: () => "x" } } as never;
  const issue = subjectPath("/repo/.ak/work/issues/28/runs/one/session", "/repo");
  const relativeIssue = subjectPath(".ak/work/issues/28/runs/two/session", "/repo");
  assert.equal(issue, "/repo/.ak/work/issues/28");
  assert.equal(relativeIssue, issue);
  assert.equal(navigatorSessionDirectory(base, issue), "/repo/.ak/work/issues/28/runs/navigator");
  const issueVariant = navigatorSessionDirectory(base, `${issue}#ad-hoc-subject`);
  assert.equal(issueVariant.startsWith("/repo/.ak/work/issues/28/runs/navigator/"), true);
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
  assert.equal(first.startsWith("/repo/.ak/work/navigator/"), true);
  assert.equal(first.includes("/navigator/navigator"), false);
});

test("NAVIGATOR_TARGETS preserves packaged registry order", () => {
  assert.deepEqual(NAVIGATOR_TARGETS.map(({ role }) => role), ["judge", "fixer", "coder", "reviewer", "collector", "doctor", "merger"]);
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
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" }).catch(() => undefined);
    // Allow the in-flight initializer to observe disposed and drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(promptCalls, 0, "disposed attendance must not prompt");
    assert.equal(setModelCalls, 0, "disposed attendance must not configure the late session");
    assert.equal(disposeCalls, 1, "created session must be disposed exactly once");
    assert.equal(events.some((event) => event.disposition === "recommendation"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status-specific route candidates outrank generics regardless of declaration order", () => {
  const route = [{ role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }];
  const generic: NavigatorCandidate = {
    id: "generic",
    matches: { role: "fixer", phase: "apply", kind: "accepted" },
    route,
    next: route[1]!,
    reason: "generic fallback",
    command: "Usage: pi --ak-role judge --help",
  };
  const unfinishedSpecific: NavigatorCandidate = {
    id: "unfinished-specific",
    matches: { role: "fixer", phase: "apply", kind: "accepted", statuses: ["unfinished"] },
    route,
    next: route[0]!,
    reason: "finish the open class",
    command: "Usage: pi --ak-role fixer --help",
  };
  const settlement = { kind: "accepted" as const, role: "fixer", phase: "apply" as const, status: "unfinished" };
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], settlement)?.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], settlement)?.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.id, "generic");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.id, "generic");
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed subject provenance replaces prose prefix branching", () => {
  const adHocRoot = "/repo/.ak/work/ad-hoc";
  assert.equal(navigatorSubjectKey(adHocRoot, `work subject: ${adHocRoot}`, "placeholder"), adHocRoot);
  // A legitimate role input that begins with the old prose prefix remains concrete work.
  const legitimate = `work subject: ${adHocRoot} with real task bytes`;
  const hashed = navigatorSubjectKey(adHocRoot, legitimate, "role_input");
  assert.notEqual(hashed, adHocRoot);
  assert.equal(hashed, `${adHocRoot}#${createHash("sha256").update(legitimate.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32)}`);
  // Wording variation of the old placeholder phrase does not disable replacement semantics:
  // only typed provenance does.
  assert.equal(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "placeholder"), adHocRoot);
  assert.notEqual(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "user_prompt"), adHocRoot);
});

test("registry output tools are the contract-owned constants", () => {
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

test("authority extraction only admits role-owned validated typed contracts", async () => {
  const { sha256Hex } = await import("../src/sha256.ts");
  const material = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    return { bytesBase64: bytes.toString("base64"), sha256: sha256Hex(bytes) };
  };
  const mergerAuthority = "merger-contract-authority";
  const mergerInput = {
    version: 1 as const,
    attemptId: "attempt-1",
    targetObjectId: "a".repeat(40),
    sourceObjectId: "b".repeat(40),
    materials: {
      task: material("task"),
      authority: material(mergerAuthority),
      targetIntent: material("target"),
      sourceIntent: material("source"),
    },
    expectedConflictPaths: ["src/a.ts"],
    resolutionScope: ["src/a.ts"],
    authorizedChecks: [],
  };
  assert.equal(navigatorAuthorityFromRoleInput("merger", JSON.stringify(mergerInput)), mergerAuthority);
  // Opaque task/packet JSON cannot override the separate authority seam.
  assert.equal(navigatorAuthorityFromRoleInput("fixer", JSON.stringify({ authority: "task-controlled", status: "planned" })), undefined);
  assert.equal(navigatorAuthorityFromRoleInput("coder", JSON.stringify({ controllingAuthority: "task-controlled" })), undefined);
  assert.equal(navigatorAuthorityFromRoleInput("reviewer", JSON.stringify({ authority: "task-controlled" })), undefined);
  assert.equal(navigatorAuthorityFromRoleInput("collector", JSON.stringify({ authority: "task-controlled" })), undefined);
  assert.equal(navigatorAuthorityFromRoleInput("judge", JSON.stringify({ authority: "task-controlled" })), undefined);
  // Incomplete merger-shaped JSON is not a validated contract leaf.
  assert.equal(navigatorAuthorityFromRoleInput("merger", JSON.stringify({ materials: { authority: material("x") } })), undefined);
});
