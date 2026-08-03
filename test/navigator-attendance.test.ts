import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNavigatorAttendance,
  formatNavigatorReport,
  NAVIGATOR_TARGETS,
  type NavigatorPreparationSession,
} from "../src/navigator-attendance.ts";

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
  let tool: any;
  let prompts = 0;
  let releasePrompt: (() => void) | undefined;
  const session: NavigatorPreparationSession = {
    async prompt() {
      prompts += 1;
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
    },
    appendEntry(_type, data) { entries.push({ type: "custom", customType: _type, data }); },
    entries: () => entries,
    dispose() {},
  };
  return {
    factory: async ({ tool: nextTool }: { tool: any }) => { tool = nextTool; return session; },
    tool: () => tool,
    release: () => releasePrompt?.(),
    prompts: () => prompts,
    entries,
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
    nav.prepare("Apply the approved task.");
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 1);
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
    assert.match(formatNavigatorReport({ disposition: "recommendation", route: events[0].route, next: events[0].next, reason: events[0].reason, command: events[0].command }), /^路线：/);
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
    nav.prepare("First");
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare-1", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.ok(events[0].route);
    await writeFile(setting, JSON.stringify({ model: "provider/two" }));
    nav.prepare("Second");
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare-2", candidate(), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[1].route, undefined);
    assert.equal(harness.prompts(), 2);
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
    nav.prepare("Wait");
    const owner = nav.settle({ kind: "human_decision", role: "coder", phase: "apply", status: "escalate" });
    const infra = nav.settle({ kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
    await Promise.all([owner, infra]);
    assert.deepEqual(events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

assert.deepEqual(NAVIGATOR_TARGETS.map(({ role }) => role), ["judge", "fixer", "coder", "reviewer", "collector", "doctor", "merger"]);
