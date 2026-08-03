import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNavigatorAttendance,
  formatNavigatorReport,
  NAVIGATOR_DEFAULT_MODEL,
  writeNavigatorModelSetting,
  NAVIGATOR_TARGETS,
  type NavigatorPreparationSession,
  navigatorSessionDirectory,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  selectNavigatorCandidate,
  subjectPath,
} from "../src/navigator-attendance.ts";
import { publicNavigatorSettlement } from "../src/role-runtime.ts";

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
  let promptText = "";
  let releasePrompt: (() => void) | undefined;
  const session: NavigatorPreparationSession = {
    async prompt(text) {
      promptText = text;
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
    promptText: () => promptText,
    entries,
    modelSettings,
  };
}

async function attendance(path: string, harness: ReturnType<typeof sessionHarness>, events: any[]) {
  return createNavigatorAttendance({
    context: context(), role: "coder", phase: "apply", subjectKey: "/repo/.ak/work/issues/28", sessionDir: "/repo/.ak/work/issues/28/runs/navigator/session",
    subject: "Fix issue 28", authority: "owner decision",
    loadSoul: async () => "route judgment",
    loadRoleHelp: async (role) => `pi --ak-role ${role} --help`,
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
    assert.equal(harness.promptText().includes("<work_subject>\nFix issue 28"), true);
    assert.equal(harness.promptText().includes("<controlling_authority>\nowner decision"), true);
    assert.equal(harness.promptText().includes("<current_prompt>"), false);
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
    assert.deepEqual(formatNavigatorReport({ disposition: "recommendation", route: events[0].route, next: events[0].next, reason: events[0].reason, command: events[0].command }).split("\n").map((line) => line.split("：", 1)[0]), ["路线", "下一步", "理由", "命令"]);
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
    const owner = nav.settle({ kind: "human_decision", role: "coder", phase: "apply", status: "escalate" });
    const infra = nav.settle({ kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
    await Promise.all([owner, infra]);
    assert.deepEqual(events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model settings are exact and typed settlement projection ignores prose and correctable errors", () => {
  assert.deepEqual(parseNavigatorModelSetting("openai-codex/gpt-5.6-luna:max"), { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" });
  assert.deepEqual(parseNavigatorModelSetting("provider/model"), { provider: "provider", model: "model", thinkingLevel: "off" });
  assert.throws(() => parseNavigatorModelSetting("provider/model:backup"));
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { message: "correctable schema wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { terminal: "infrastructure_failure", message: "network wording" } }), { kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
  assert.deepEqual(publicNavigatorSettlement("judge", null, { toolName: "ak_judge_output", isError: false, details: { judgeStatus: "escalate", report: "any wording" } }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  const route = [{ role: "judge" as const, phase: null }];
  const source = candidate().candidates[0]!;
  const candidates = [{ id: source.id, matches: { role: "reviewer", phase: null, kind: "accepted" as const, statuses: ["completed", "refused"] }, route, next: route[0]!, reason: source.reason, command: source.command }];
  assert.equal(selectNavigatorCandidate(candidates, { kind: "accepted", role: "reviewer", phase: null, status: "completed" })?.id, candidates[0]!.id);
  assert.equal(selectNavigatorCandidate(candidates, { kind: "accepted", role: "reviewer", phase: null, status: "refused" })?.id, candidates[0]!.id);
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

test("session placement is stable, colocated, and isolates ad hoc subjects", () => {
  const base = { cwd: "/repo", sessionManager: { getSessionDir: () => "", getSessionId: () => "x" } } as never;
  const issue = subjectPath("/repo/.ak/work/issues/28/runs/one/session", "/repo");
  assert.equal(issue, "/repo/.ak/work/issues/28");
  assert.equal(navigatorSessionDirectory(base, issue), "/repo/.ak/work/issues/28/runs/navigator");
  const first = navigatorSessionDirectory(base, "/repo/task-a.md");
  const second = navigatorSessionDirectory(base, "/repo/task-b.md");
  assert.notEqual(first, second);
  assert.equal(first.startsWith("/repo/.ak/work/navigator/"), true);
  assert.equal(first.includes("/navigator/navigator"), false);
});

assert.deepEqual(NAVIGATOR_TARGETS.map(({ role }) => role), ["judge", "fixer", "coder", "reviewer", "collector", "doctor", "merger"]);
