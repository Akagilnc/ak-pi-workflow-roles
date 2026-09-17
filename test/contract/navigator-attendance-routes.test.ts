// #420 整改拆分：路线记忆与重绑家族 — #959 删候选排名/重绑后只保留仍有效契约
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createNavigatorAttendance,
  formatNavigatorReport,
  settlementNavigationFromEvent,
  writeNavigatorModelSetting,
  navigatorSubjectKey,
  navigatorSubjectKeyForInput,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  subjectPath,
} from "../../src/navigator-attendance.ts";
import {
  context,
  sessionHarness,
  attendance,
  proseAdvice,
} from "../helpers/navigator-attendance-kit.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("persistent model edits are immediate and have no fallback", async () => {
  await withTempRoot("navigator-model-setting-", async (root) => {
    const path = join(root, "navigator-model.json");
    const started = Date.now();
    await writeNavigatorModelSetting("provider/one:max", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/one:max");
    await writeNavigatorModelSetting("provider/two", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/two");
    assert.equal(Date.now() - started < 5000, true);
    await writeFile(path, JSON.stringify({ model: "provider/one:backup" }));
    const opaqueSuffix = await readNavigatorModelSetting(path);
    assert.deepEqual(parseNavigatorModelSetting(opaqueSuffix), {
      provider: "provider",
      model: "one",
      thinkingLevel: "backup",
    });
    await writeFile(path, JSON.stringify({ model: "provider-only-no-slash" }));
    const invalid = await readNavigatorModelSetting(path);
    assert.throws(() => parseNavigatorModelSetting(invalid));
  });
});

test("future arrival is typed and presentation-only", async () => {
  await withTempRoot("navigator-arrival-", async (root) => {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    await nav.settle({ kind: "arrival", role: "lander", phase: null, message: "抵达" });
    assert.equal(events[0]?.disposition, "arrival");
    assert.equal(events[0]?.arrivalMessage, "抵达");
    assert.equal(formatNavigatorReport({ disposition: "arrival", arrivalMessage: "抵达" }), "抵达");
    assert.equal(harness.prompts(), 0);
  });
});

test("#959 settlement navigation essentials keep prose as written", () => {
  const adviceEvent = {
    version: 1 as const,
    disposition: "advice" as const,
    invocationId: "i1",
    role: "judge",
    phase: null,
    subjectKey: "/repo",
    prose: "下一步送 reviewer 独立审阅",
  };
  assert.deepEqual(settlementNavigationFromEvent(adviceEvent), {
    disposition: "advice",
    prose: "下一步送 reviewer 独立审阅",
  });
  assert.equal(
    settlementNavigationFromEvent({
      version: 1,
      disposition: "advice",
      invocationId: "i2",
      role: "judge",
      phase: null,
      subjectKey: "/repo",
      prose: "   ",
    }),
    undefined,
  );
  assert.equal(
    formatNavigatorReport({ disposition: "advice", prose: "送大理寺" }),
    "送大理寺",
  );
});

test("work subjects remain stable and isolate ad hoc work", async () => {
  const issue = subjectPath("/repo/.ak/work/issues/28/runs/one/session", "/repo");
  assert.equal(issue, "/repo/.ak/work/issues/28");
  assert.equal(subjectPath(".ak/work/issues/28/runs/two/session", "/repo"), issue);
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"), "/repo/.ak/work/ad-hoc");
  assert.equal(subjectPath("/repo/.ak/work/ad-hoc/runs/reviewer/fix-packet.json", "/repo"), "/repo/.ak/work/ad-hoc");

  const adHocRoot = "/repo/.ak/work/ad-hoc";
  assert.equal(navigatorSubjectKey(adHocRoot, "same concrete task"), navigatorSubjectKey(adHocRoot, "same   concrete task"));
  assert.notEqual(navigatorSubjectKey(adHocRoot, "same concrete task"), navigatorSubjectKey(adHocRoot, "different task"));
  assert.equal(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/other-task.md", "/repo"),
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/reviewer/fix-packet.json", "/repo"),
    "natural role-specific filenames remain one work subject",
  );
  assert.notEqual(
    navigatorSubjectKeyForInput(adHocRoot, "/repo/.ak/work/ad-hoc/runs/coder/task.md", "/repo"),
    navigatorSubjectKeyForInput("/repo/.ak/work/other-ad-hoc", "/repo/.ak/work/other-ad-hoc/runs/reviewer/fix-packet.json", "/repo"),
    "distinct work roots remain isolated",
  );
  assert.equal(navigatorSubjectKey("/repo/task.md", "task text"), "/repo/task.md");

  const ledgerSession = "/custom/home/.ak-roles/books/repo/issues/28/runs/judge@src/session";
  assert.equal(subjectPath(ledgerSession, "/repo"), "/repo/.ak/work");
  assert.equal(subjectPath("", "/repo"), "/repo/.ak/work");
  assert.equal(subjectPath(ledgerSession, issue), issue);
  // Any `.ak-roles/books/...` tree is ledger topology (ADR 0048 / #604), not work identity —
  // even a mislocated tree under a repo root derives subject from cwd, never the ledger path.
  assert.equal(subjectPath("/repo/.ak-roles/books/repo/issues/28/runs/judge@src/session", "/repo"), "/repo/.ak/work");

  await withTempRoot("ak-nav-physical-", async (home) => {
    const { realpathSync } = await import("node:fs");
    const physicalIssue = resolve(home, ".ak/work/issues/28");
    const session = resolve(home, ".ak-roles/books/h/runs/judge-navigator/session");
    await mkdir(physicalIssue, { recursive: true });
    await mkdir(session, { recursive: true });
    assert.equal(subjectPath(session, physicalIssue), physicalIssue);
    assert.equal(subjectPath(realpathSync(session), physicalIssue), physicalIssue);
  });

  assert.equal(navigatorSubjectKey(adHocRoot, `work subject: ${adHocRoot}`, "placeholder"), adHocRoot);
  const legitimate = `work subject: ${adHocRoot} with real task bytes`;
  const hashed = navigatorSubjectKey(adHocRoot, legitimate, "role_input");
  assert.equal(hashed, `${adHocRoot}#${createHash("sha256").update(legitimate.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 32)}`);
  assert.equal(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "placeholder"), adHocRoot);
  assert.notEqual(navigatorSubjectKey(adHocRoot, "placeholder subject for work", "user_prompt"), adHocRoot);
});

test("dispose during pending createSession drains the created session without prompt or assignment", async () => {
  await withTempRoot("navigator-dispose-race-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolveGate) => { releaseCreate = resolveGate; });
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolveStarted) => { markCreateStarted = resolveStarted; });
    let markSessionDisposed!: () => void;
    const sessionDisposed = new Promise<void>((resolveDisposed) => { markSessionDisposed = resolveDisposed; });
    let disposeCalls = 0;
    let promptCalls = 0;
    let setModelCalls = 0;
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(root),
      role: "coder",
      phase: "apply",
      subjectKey: "/repo/.ak/work/issues/28",
      subject: "Fix issue 28",
      authority: "owner decision",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async () => "Usage: pi --ak-role coder --help",
      modelSettingPath: setting,
      createSession: async () => {
        markCreateStarted();
        await createGate;
        return {
          async prompt() { promptCalls += 1; },
          appendEntry() {},
          entries: () => [],
          async setModel() { setModelCalls += 1; },
          getThinkingLevel: () => "off",
          recordPointer: () => "/fixture/navigator-record",
          dispose() { disposeCalls += 1; markSessionDisposed(); },
        };
      },
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    await createStarted;
    await nav.dispose();
    releaseCreate();
    await sessionDisposed;
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(promptCalls, 0, "disposed attendance must not prompt");
    assert.equal(setModelCalls, 0, "disposed attendance must not configure the late session");
    assert.equal(disposeCalls, 1, "created session must be disposed exactly once");
    assert.equal(events.some((event) => event.disposition === "advice"), false);
  });
});

test("attendance dispose settles session close rejection on the caller", async () => {
  await withTempRoot("navigator-attendance-close-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    let releasePrompt: (() => void) | undefined;
    try {
      const setting = join(root, "model.json");
      await writeFile(setting, JSON.stringify({ model: "provider/model" }));
      const closeBoom = new Error("session close failed");
      let promptStarted!: () => void;
      const prompted = new Promise<void>((resolvePrompted) => { promptStarted = resolvePrompted; });
      const heldPrompt = new Promise<void>((resolveHeld) => { releasePrompt = resolveHeld; });
      const nav = createNavigatorAttendance({
        context: context(root),
        role: "coder",
        phase: "apply",
        subjectKey: "/repo/.ak/work/issues/28",
        subject: "Fix issue 28",
        authority: "owner decision",
        loadSoul: async () => "route judgment",
        loadRoleHelp: async () => "Usage: pi --ak-role coder --help",
        modelSettingPath: setting,
        createSession: async () => ({
          async prompt() {
            promptStarted();
            await heldPrompt;
          },
          appendEntry() {},
          entries: () => [],
          async setModel() {},
          getThinkingLevel: () => "off" as const,
          recordPointer: () => "/fixture/navigator-record",
          dispose() { return Promise.reject(closeBoom); },
        }),
        onEvent: async () => {},
      });
      nav.prepare();
      await prompted;
      await assert.rejects(
        () => Promise.resolve(nav.dispose()),
        (error: unknown) => error === closeBoom,
      );
    } finally {
      releasePrompt?.();
    }
  });
});

test("resumed setModel session failures preserve typed source and cause", async () => {
  await withTempRoot("navigator-resumed-cause-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const events: any[] = [];
    let setModelCalls = 0;
    let created = false;
    const nav = createNavigatorAttendance({
      context: context(root),
      role: "judge",
      phase: null,
      subjectKey: "/repo/.ak/work/issues/28",
      subject: "task",
      authority: "authority",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async () => "help",
      modelSettingPath: setting,
      createSession: async ({ tool }) => {
        created = true;
        return {
          async prompt() {
            await tool.execute(
              "prepare",
              proseAdvice("resume path — 送 reviewer"),
              undefined,
              undefined,
              {} as never,
            );
          },
          appendEntry() {},
          entries: () => [],
          async setModel() {
            setModelCalls += 1;
            if (setModelCalls > 1) {
              throw new Error("setModel blew up with untyped wording");
            }
          },
          getThinkingLevel: () => "off",
          recordPointer: () => "/fixture/navigator-record",
          dispose() {},
        };
      },
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
    assert.equal(created, true);
    assert.equal(events[0]?.disposition, "advice");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
    assert.equal(events[1]?.disposition, "unavailable");
    assert.equal(events[1]?.unavailableSource, "session");
    assert.equal(events[1]?.unavailableCause, "session");
  });
});

test("#959 free-form prose without next is advice, not unavailable", async () => {
  await withTempRoot("navigator-prose-no-next-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    // Historical shape that used to be rejected for missing candidates[].next
    await harness.tool().execute(
      "prepare",
      {
        role: "judge",
        command: "ak-role judge",
        reason: "应先由大理寺独立核验",
      },
      undefined,
      undefined,
      {} as never,
    );
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[0]?.disposition, "advice");
    assert.ok(typeof events[0]?.prose === "string" && events[0].prose.includes("大理寺"));
  });
});

test("#959 empty prose after prepare is no-advice, not machine-usable unavailable", async () => {
  await withTempRoot("navigator-empty-prose-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare", { prose: "   " }, undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[0]?.disposition, "no-advice");
  });
});

test("#959 prose advice is presented as written", async () => {
  await withTempRoot("navigator-prose-written-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare", proseAdvice("先送 reviewer"), undefined, undefined, {} as never);
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "先送 reviewer");
  });
});

test("#959 assistant prose without prepare tool is advice; no typed 催交", async () => {
  await withTempRoot("navigator-prose-no-tool-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    nav.prepare();
    while (harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    harness.finishWithAssistantProse("下一步送 reviewer，无需 JSON 工具。");
    harness.release();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 1, "prose exit must not open typed delivery 催交");
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "下一步送 reviewer，无需 JSON 工具。");
  });
});
