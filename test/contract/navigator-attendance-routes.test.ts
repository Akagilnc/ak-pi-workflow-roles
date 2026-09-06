// #420 整改拆分：路线记忆与重绑家族
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createNavigatorAttendance, createNavigatorPrepareTool, decorateSettlementWithNavigation, formatNavigatorReport, NAVIGATOR_DEFAULT_MODEL, NAVIGATOR_PREPARE_TOOL_NAME, settlementNavigationFromEvent, writeNavigatorModelSetting, navigatorSubjectKey, navigatorSubjectKeyForInput, parseNavigatorModelSetting, readNavigatorModelSetting, selectNavigatorCandidate, subjectPath } from "../../src/navigator-attendance.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { createHash } from "node:crypto";
import {
  context,
  candidate,
  sessionHarness,
  attendance,
  settleAnsweringRebind,
} from "../helpers/navigator-attendance-kit.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

// #685: host-neutral native AgentSession prompt cases culled — providerFailure/
// terminal-less. C3 §I: 无具名 @navigator 卷，不得用异常面总称结清
// (docs/research/issue-685-c3-deleted-contract-handoff.md). Call-input remains.

test("persistent model edits are immediate and have no fallback", async () => {
  await withTempRoot("navigator-model-setting-", async (root) => {
    const path = join(root, "navigator-model.json");
    assert.equal(await readNavigatorModelSetting(path), NAVIGATOR_DEFAULT_MODEL);
    const started = Date.now();
    await writeNavigatorModelSetting("provider/one:max", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/one:max");
    await writeNavigatorModelSetting("provider/two", path);
    assert.equal(await readNavigatorModelSetting(path), "provider/two");
    assert.equal(Date.now() - started < 5000, true);
    await writeFile(path, JSON.stringify({ model: "provider/one:backup" }));
    const opaqueSuffix = await readNavigatorModelSetting(path);
    // Suffix is opaque pass-through — no whitelist reject at parse (#683 / #675 ⑥).
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
    const nav = await attendance(setting, harness, events);
    await nav.settle({ kind: "arrival", role: "lander", phase: null, message: "抵达" });
    assert.equal(events[0]?.disposition, "arrival");
    assert.equal(events[0]?.arrivalMessage, "抵达");
    assert.equal(formatNavigatorReport({ disposition: "arrival", arrivalMessage: "抵达" }), "抵达");
    assert.equal(harness.prompts(), 0);
  });
});

test("settlement decoration carries recommendation only; unavailable and no-advice stay absent", () => {
  const base = {
    content: [{ type: "text" as const, text: "Judge verdict accepted" }],
    details: { judgeStatus: "converged" } };
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
    command: "Usage: pi --ak-role reviewer --help" };
  const decorated = decorateSettlementWithNavigation(base, {
    event: recommendationEvent,
    report: {
      disposition: "recommendation",
      route: recommendationEvent.route,
      next: recommendationEvent.next,
      reason: recommendationEvent.reason,
      command: recommendationEvent.command } });
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
    command: recommendationEvent.command });
  // Direction-only recommendation (no reason/command) still settles as navigation essentials.
  assert.deepEqual(
    settlementNavigationFromEvent({
      version: 1,
      disposition: "recommendation",
      invocationId: "i2",
      role: "judge",
      phase: null,
      subjectKey: "/repo",
      next: { role: "fixer", phase: "apply" } }),
    {
      disposition: "recommendation",
      next: { role: "fixer", phase: "apply" } },
  );
  assert.equal(
    decorateSettlementWithNavigation(base, {
      event: { ...recommendationEvent, disposition: "unavailable", unavailableReason: "x", unavailableSource: "model", unavailableCause: "model" },
      report: { disposition: "unavailable", unavailableReason: "x", unavailableSource: "model", unavailableCause: "model" } }),
    undefined,
  );
  assert.equal(decorateSettlementWithNavigation(base, undefined), undefined);
  assert.equal(
    decorateSettlementWithNavigation(base, {
      event: { ...recommendationEvent, disposition: "no-advice" },
      report: { disposition: "no-advice" } }),
    undefined,
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
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    let markSessionDisposed!: () => void;
    const sessionDisposed = new Promise<void>((resolve) => { markSessionDisposed = resolve; });
    let disposeCalls = 0;
    let promptCalls = 0;
    let setModelCalls = 0;
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
          dispose() { disposeCalls += 1; markSessionDisposed(); } };
      },
      onEvent: async (event) => { events.push(event); } });
    nav.prepare();
    await createStarted;
    await nav.dispose();
    releaseCreate();
    await sessionDisposed;
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(promptCalls, 0, "disposed attendance must not prompt");
    assert.equal(setModelCalls, 0, "disposed attendance must not configure the late session");
    assert.equal(disposeCalls, 1, "created session must be disposed exactly once");
    assert.equal(events.some((event) => event.disposition === "recommendation"), false);
  });
});

test("attendance dispose settles session close rejection on the caller", async () => {
  await withTempRoot("navigator-attendance-close-", async (root) => {
    let releasePrompt: (() => void) | undefined;
    try {
      const setting = join(root, "model.json");
      await writeFile(setting, JSON.stringify({ model: "provider/model" }));
      const closeBoom = new Error("session close failed");
      let promptStarted!: () => void;
      const prompted = new Promise<void>((resolve) => { promptStarted = resolve; });
      const heldPrompt = new Promise<void>((resolve) => { releasePrompt = resolve; });
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
          dispose() { return Promise.reject(closeBoom); } }),
        onEvent: async () => {} });
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


test("settlement-bound rebind is always reachable and passes divergent advice through as-is", async () => {
  // Real defect under repair: speculative prepare cannot see the just-accepted terminal.
  // Rebind once with currentSettlement; code must not judge whether next is "correct".
  // Acceptance: a suggestion that differs from the settlement appears unchanged on the event.
  const rows = [
    {
      label: "collector accepted → divergent merger advice kept",
      role: "collector" as const,
      phase: null,
      subjectKey: "/Users/akagilnc/WorkSpace/Ming_LLM-558/.ak/work",
      subject: JSON.stringify({ groups: [{ identity: { userType: "Bot", userId: 199175422 }, attendance: true }] }),
      authority: JSON.stringify({ groups: [{ identity: { userType: "Bot", userId: 199175422 }, attendance: true }] }),
      invocationId: "019fe954-f995-7c1a-ae42-98c5740429f0",
      settlement: { kind: "accepted" as const, role: "collector" as const, phase: null },
      projectJudgeStatus: undefined as undefined | "continue" | "converged",
      projectFixerStatus: undefined as undefined | "completed",
      speculativeCandidate: {
        next: { role: "judge" as const, phase: null },
        reason: "speculative placeholder discarded by settlement-bound rebind" },
      rebindCandidate: {
        next: { role: "merger" as const, phase: null },
        reason: "collector 已收齐；游奕使建议直接合并（调用者可忽略）" },
      expectedNext: { role: "merger" as const, phase: null },
      expectedCommand: "ak-role merger",
      expectedReason: "collector 已收齐；游奕使建议直接合并（调用者可忽略）" },
    {
      label: "fixer unfinished → divergent judge advice kept",
      role: "fixer" as const,
      phase: "apply" as const,
      subjectKey: "/Users/akagilnc/WorkSpace/Ming_LLM/.ak/work",
      subject: JSON.stringify({ issue: 558, remainingScope: "still open" }),
      authority: JSON.stringify({ issue: 558, repairSurface: "open findings" }),
      invocationId: "019fe97d-f778-716f-b528-53236e0503a0",
      settlement: { kind: "accepted" as const, role: "fixer" as const, phase: "apply" as const, status: "unfinished" as const },
      projectJudgeStatus: undefined,
      projectFixerStatus: undefined,
      speculativeCandidate: {
        next: { role: "fixer" as const, phase: "apply" as const },
        reason: "speculative continue" },
      rebindCandidate: {
        next: { role: "judge" as const, phase: null },
        reason: "unfinished 也建议回大理寺（代码不得丢弃）" },
      expectedNext: { role: "judge" as const, phase: null },
      expectedCommand: "ak-role judge",
      expectedReason: "unfinished 也建议回大理寺（代码不得丢弃）" },
    {
      label: "judge continue → divergent merger advice kept",
      role: "judge" as const,
      phase: null,
      subjectKey: "/Users/akagilnc/WorkSpace/Ming_LLM-557/.ak/work",
      subject: JSON.stringify({ issue: 557, judgeStatus: "continue" }),
      authority: JSON.stringify({ issue: 557, judgeStatus: "continue" }),
      invocationId: "019fe96d-2a14-7e0e-be03-ee9da3a81708",
      settlement: { kind: "accepted" as const, role: "judge" as const, phase: null, status: "continue" as const },
      projectJudgeStatus: "continue" as const,
      projectFixerStatus: undefined,
      speculativeCandidate: {
        next: { role: "fixer" as const, phase: "apply" as const },
        reason: "speculative fixer" },
      rebindCandidate: {
        next: { role: "merger" as const, phase: null },
        reason: "continue 也建议 merger（代码无权裁定）" },
      expectedNext: { role: "merger" as const, phase: null },
      expectedCommand: "ak-role merger",
      expectedReason: "continue 也建议 merger（代码无权裁定）" },
    {
      label: "judge converged → merger advice kept after rebind",
      role: "judge" as const,
      phase: null,
      subjectKey: "/Users/akagilnc/WorkSpace/Ming_LLM-557/.ak/work",
      subject: JSON.stringify({ issue: 557, judgeStatus: "converged" }),
      authority: JSON.stringify({ issue: 557, judgeStatus: "converged" }),
      invocationId: "019fe96d-2a14-7e0e-be03-ee9da3a81708",
      settlement: { kind: "accepted" as const, role: "judge" as const, phase: null, status: "converged" as const },
      projectJudgeStatus: "converged" as const,
      projectFixerStatus: undefined,
      speculativeCandidate: {
        next: { role: "merger" as const, phase: null },
        reason: "speculative merger" },
      rebindCandidate: {
        next: { role: "merger" as const, phase: null },
        reason: "converged；合并收尾" },
      expectedNext: { role: "merger" as const, phase: null },
      expectedCommand: "ak-role merger",
      expectedReason: "converged；合并收尾" },
  ] as const;

  for (const row of rows) {
    await withTempRoot("navigator-rebind-as-is-", async (root) => {
      const setting = join(root, "model.json");
      await writeFile(setting, JSON.stringify({ model: "provider/model" }));
      const harness = sessionHarness();
      const events: any[] = [];

      const settlement = row.projectJudgeStatus !== undefined || row.projectFixerStatus !== undefined
        ? (() => {
            const projected = row.projectJudgeStatus !== undefined
              ? publicNavigatorSettlement("judge", null, {
                  toolName: JUDGE_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: { judgeStatus: row.projectJudgeStatus } })
              : publicNavigatorSettlement("fixer", "apply", {
                  toolName: FIXER_OUTPUT_TOOL_NAME,
                  isError: false,
                  details: { status: row.projectFixerStatus } });
            assert.ok(projected, `${row.label}: projection must yield settlement`);
            assert.deepEqual(projected, row.settlement, `${row.label}: projected settlement shape`);
            return projected;
          })()
        : row.settlement;

      const nav = createNavigatorAttendance({
        context: context(),
        role: row.role,
        phase: row.phase,
        subjectKey: row.subjectKey,
        subject: row.subject,
        authority: row.authority,
        loadSoul: async () => "route judgment",
        loadRoleHelp: async (role) => `Usage: ak-role ${role}`,
        createSession: harness.factory,
        modelSettingPath: setting,
        invocationId: row.invocationId,
        onEvent: async (event) => { events.push(event); } });

      // Speculative prepare (before terminal) — discarded by settlement-bound rebind.
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(harness.retainedContext().currentSettlement, undefined, `${row.label}: speculative prepare has no currentSettlement`);
      await harness.tool().execute(
        `speculative-${row.label}`,
        { candidates: [row.speculativeCandidate] },
        undefined,
        undefined,
        {} as never,
      );
      harness.release();

      // Settle always rebinds once with currentSettlement (no semantic gate).
      const settling = nav.settle(settlement);
      while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        harness.retainedContext().currentSettlement,
        settlement,
        `${row.label}: rebind prepare must carry the just-accepted settlement`,
      );
      await harness.tool().execute(
        `rebind-${row.label}`,
        { candidates: [row.rebindCandidate] },
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await settling;

      assert.equal(events.length, 1, row.label);
      assert.equal(events[0]?.disposition, "recommendation", row.label);
      assert.deepEqual(events[0]?.next, row.expectedNext, `${row.label}: divergent advice must pass through as-is`);
      assert.equal(events[0]?.command, row.expectedCommand, row.label);
      assert.equal(events[0]?.reason, row.expectedReason, `${row.label}: reason must not be rewritten`);
      assert.equal(events[0]?.invocationId, row.invocationId, row.label);
      assert.equal(harness.prompts(), 2, `${row.label}: unmatched speculative advice forces one settlement-bound rebind`);

      // Real entry → external receipt surface: divergent recommendation decorates settlement content.
      const decorated = decorateSettlementWithNavigation(
        {
          content: [{ type: "text" as const, text: "role terminal accepted" }],
          details: { ok: true } },
        { event: events[0], report: {
          disposition: "recommendation",
          next: events[0].next,
          reason: events[0].reason,
          command: events[0].command } },
      );
      assert.ok(decorated, `${row.label}: recommendation must decorate settlement`);
      const text = (decorated.content[0] as { text: string }).text;
      assert.equal(text.includes(row.expectedReason), true, `${row.label}: reason appears in settlement content`);
      assert.equal(text.includes(row.expectedCommand), true, `${row.label}: command appears in settlement content`);
      assert.deepEqual(settlementNavigationFromEvent(events[0])?.next, row.expectedNext, `${row.label}: navigation essentials keep next as-is`);
    });
  }
});

test("settlement-bound rebind that repeats divergent advice still emits recommendation as-is", async () => {
  // Former "still contradicts → unavailable" path deleted: code has no authority to discard advice.
  await withTempRoot("navigator-rebind-keep-divergent-", async (root) => {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(),
      role: "collector",
      phase: null,
      subjectKey: "/repo/.ak/work",
      subject: "collect materials",
      authority: "collect materials",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async () => "help",
      createSession: harness.factory,
      modelSettingPath: setting,
      onEvent: async (event) => { events.push(event); } });
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute(
      "speculative-merger",
      { candidates: [{ next: { role: "merger" } }] },
      undefined,
      undefined,
      {} as never,
    );
    harness.release();
    const settlement = { kind: "accepted" as const, role: "collector" as const, phase: null };
    const settling = nav.settle(settlement);
    while (harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.retainedContext().currentSettlement, settlement);
    await harness.tool().execute(
      "rebind-still-merger",
      { candidates: [{ next: { role: "merger" }, reason: "still think merge" }] },
      undefined,
      undefined,
      {} as never,
    );
    harness.release();
    await settling;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "recommendation");
    assert.deepEqual(events[0]?.next, { role: "merger", phase: null });
    assert.equal(events[0]?.reason, "still think merge");
    assert.equal(events[0]?.unavailableReason, undefined);
  });
});

test("settlement-matched speculative advice is not rebound and divergent next still passes through", async () => {
  // matches keys the candidate to this settlement — not a next.role legality check.
  // Divergent next is still emitted as-is; no second prepare.
  await withTempRoot("navigator-matched-no-rebind-", async (root) => {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(),
      role: "collector",
      phase: null,
      subjectKey: "/repo/.ak/work",
      subject: "collect materials",
      authority: "collect materials",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async () => "help",
      createSession: harness.factory,
      modelSettingPath: setting,
      onEvent: async (event) => { events.push(event); } });
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute(
      "matched-divergent",
      {
        candidates: [{
          matches: { role: "collector", phase: null, kind: "accepted" },
          next: { role: "merger", phase: null },
          reason: "matched to collector accepted; next=merger kept as-is" }] },
      undefined,
      undefined,
      {} as never,
    );
    harness.release();
    await nav.settle({ kind: "accepted", role: "collector", phase: null });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "recommendation");
    assert.deepEqual(events[0]?.next, { role: "merger", phase: null });
    assert.equal(events[0]?.reason, "matched to collector accepted; next=merger kept as-is");
    assert.equal(harness.prompts(), 1, "settlement-matched speculative advice must not force rebind");
  });
});

test("status-specific route candidates outrank generics regardless of declaration order", () => {
  const route = [{ role: "fixer" as const, phase: "apply" as const }, { role: "judge" as const, phase: null }];
  const generic = candidate({
    id: "generic",
    matches: { role: "fixer", phase: "apply", kind: "accepted" },
    route,
    next: route[1]!,
    reason: "generic fallback" }).candidates[0]!;
  const unfinishedSpecific = candidate({
    id: "unfinished-specific",
    matches: { role: "fixer", phase: "apply", kind: "accepted", statuses: ["unfinished"] },
    route,
    next: route[0]!,
    reason: "finish the open class" }).candidates[0]!;
  const settlement = { kind: "accepted" as const, role: "fixer", phase: "apply" as const, status: "unfinished" };
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], settlement)?.candidate.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], settlement)?.candidate.id, "unfinished-specific");
  assert.equal(selectNavigatorCandidate([generic, unfinishedSpecific], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.candidate.id, "generic");
  assert.equal(selectNavigatorCandidate([unfinishedSpecific, generic], { kind: "accepted", role: "fixer", phase: "apply", status: "completed" })?.candidate.id, "generic");
  // Statuses list membership (absorbed from model-settings carrier).
  const reviewerStatuses = candidate({
    matches: { role: "reviewer", phase: null, kind: "accepted", statuses: ["completed", "refused"] },
    route: [{ role: "judge", phase: null }],
    next: { role: "judge", phase: null } }).candidates;
  assert.equal(selectNavigatorCandidate(reviewerStatuses, { kind: "accepted", role: "reviewer", phase: null, status: "completed" })?.candidate.id, reviewerStatuses[0]!.id);
  assert.equal(selectNavigatorCandidate(reviewerStatuses, { kind: "accepted", role: "reviewer", phase: null, status: "refused" })?.candidate.id, reviewerStatuses[0]!.id);
});

test("resumed setModel session failures preserve typed source and cause", async () => {
  await withTempRoot("navigator-resumed-cause-", async (root) => {
    const setting = join(root, "model.json");
    // Thinking stick/availability re-check is gone (#683); only session setModel failures remain typed here.
    const cases = [
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
                  command: "Usage: pi --ak-role reviewer --help" }] }, undefined, undefined, {} as never);
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
            recordPointer: () => "/fixture/navigator-record",
            dispose() {} };
        },
        onEvent: async (event) => { events.push(event); } });
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
  });
});



