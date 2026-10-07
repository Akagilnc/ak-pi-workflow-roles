// #420 整改拆分：接缝与恢复家族
// #178: restore prepare consumers with per-case seat fixture + explicit context.home.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { createRoleRuntimeExtension, projectClosedSubmissionLifecycle } from "../../src/role-runtime.ts";
import { buildNavigatorInfrastructureFailureFact } from "../../src/navigator-invocation-identity.ts";
import { createNativeNavigatorSessionFactory, createNavigatorAttendance, createNavigatorPrepareTool, NAVIGATOR_EVENT_TYPE, NavigatorUnavailableError, NAVIGATOR_TARGETS } from "../../src/navigator-attendance.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { extractNavigatorFact, NAVIGATOR_POST_ROLE_GRACE_MS } from "../../src/public-cli/settlement.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import { createDefaultGateOfficerSummon } from "../../src/submission-gate.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { projectActivationFlags } from "../../src/role-activation-flags.ts";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "../../src/gleaner-left-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { loadNavigatorWorkContext, resolveNavigatorAuthorityMaterial } from "../../extensions/role-runtime.ts";
import type { RoleEnvelopeHost, RoleHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  context,
  sessionHarness,
  attendance,
  settleWithAdvice,
  prepareWithAdvice,
  byStatusAdvice,
} from "../helpers/navigator-attendance-kit.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { flushEventLoopTurns, packageRoot, seedGitRepository, seedRoleRepo, waitForEventLoopCondition, withActivationHome } from "../helpers/pi-test-harness.ts";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { seedCurrentSection } from "../helpers/run-dossier-fixture.ts";

test("shared accepted submission binds settled attendance before public extraction; prior activation cannot deliver late", async () => {
  await withTempRoot("navigator-bound-closure-", async (home) => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const runDir = join(home, ".ak-roles", "books", "fixture", "unbound", "runs", "bound@judge");
    const previousRunDir = process.env.AK_ROLE_RUN_DIR;
    process.env.AK_ROLE_RUN_DIR = runDir;
    try {
      const handlers = new Map<string, (event: any, ctx: any) => any>();
      const tools = new Map<string, any>();
      const sent: unknown[] = [];
      const callbacks: Array<(event: any, report: any) => void | Promise<void>> = [];
      const host = {
        registerFlag() {}, getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
        on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        getAllTools() { return [...tools.values()]; },
        setActiveTools() {}, getActiveTools() { return [...tools.keys()]; },
        appendEntry() {},
      };
      createRoleRuntimeExtension({
        loadRoleSoul: async () => "JUDGE LAW",
        loadNavigatorWorkContext: async () => ({
          subjectKey: `${runDir}/work`, subject: "work", authority: "authority",
          subjectProvenance: "role_input" as const,
        }),
        createNavigatorAttendance: (options) => {
          callbacks.push(options.onEvent);
          return {
            prepare() {}, setWorkContext() {}, warmHelp() {}, isPreparing: () => false,
            async settle() {
              await options.onEvent({
                version: 1, disposition: "no-advice", invocationId: options.invocationId,
                role: options.role, phase: options.phase, subjectKey: options.subjectKey,
              }, { disposition: "no-advice" });
            },
            dispose() {},
          };
        },
      })({
        host: host as RoleHost, appendEntry: host.appendEntry,
        sendMessage(message) { sent.push(message); },
        startKeepalive() {}, stopKeepalive() {},
      });
      const sessionManager = SessionManager.create(home, join(runDir, "session"));
      const ctx = { cwd: home, sessionManager, runDirectory: runDir, abort() {} };
      await handlers.get("session_start")?.({}, ctx);
      const tool = tools.get(JUDGE_OUTPUT_TOOL_NAME);
      assert.ok(tool);
      await tool.execute("bound-output", { status: "converged" }, undefined, undefined, ctx);
      const entries = sessionManager.getEntries();
      const closure = entries.find((entry: any) => entry.type === "custom" && entry.customType === "ak-role-submission-closure");
      assert.equal((closure as any)?.data?.navigator?.disposition, "no-advice");
      assert.equal(extractNavigatorFact(entries).disposition, "no-advice");
      await handlers.get("session_start")?.({}, ctx);
      await callbacks[0]?.({ version: 1, disposition: "advice", prose: "late", invocationId: "old", role: "judge", phase: null, subjectKey: "old" }, { disposition: "advice", prose: "late" });
      await handlers.get("agent_settled")?.({}, ctx);
      assert.deepEqual(sent, []);
    } finally {
      if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    }
  });
});

test("settlement rejection still records an accepted closure with unavailable attendance", async () => {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const ctx = { sessionManager: { appendCustomEntry(customType: string, data: unknown) { entries.push({ customType, data }); } } } as never;
  const writeFailure = new Error("navigator write failed");
  await assert.rejects(projectClosedSubmissionLifecycle(
    { role: "judge", kind: "accepted", accepted: { status: "converged" } },
    ctx, null, () => {}, async () => { throw writeFailure; },
  ), (error: unknown) => error === writeFailure);
  assert.equal(entries.length, 1);
  assert.equal((entries[0]?.data as { navigator?: unknown }).navigator, undefined);
  assert.equal(extractNavigatorFact([{ type: "custom", ...entries[0]! }] as never).disposition, "unavailable");
});

test("role-input authority wins verbatim; files fall back; neither is honestly unavailable", async () => {
  assert.equal(resolveNavigatorAuthorityMaterial("packet authority\n", "file authority\n"), "packet authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial("packet authority\n", undefined), "packet authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial(undefined, "file authority\n"), "file authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial("   \n", "file authority\n"), "file authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial(undefined, undefined), undefined);
  assert.equal(resolveNavigatorAuthorityMaterial("", undefined), undefined);

  await withTempRoot("navigator-input-authority-", async (root) => {
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
    return withPrimaryAwareCleanup(
      async () => {

    const workRoot = resolve(root, ".ak/work/issues/91");
    await mkdir(workRoot, { recursive: true });
    // #1168: fixer no longer has a packet input flag; use merger's remaining input path.
    const inputPath = resolve(workRoot, "merger-input.json");
    const inputBytes = "# Merger materials\n\nCourt-binding authority for issue 91.\n";
    await writeFile(inputPath, inputBytes, "utf8");

    const sessionCtx = (cwd: string, sessionDir: string) => ({
      cwd,
      sessionManager: { getSessionDir: () => sessionDir } }) as never;
    const mergerPi = { getFlag: (name: string) => name === "ak-merger-input" ? inputPath : undefined };
    const noInputPi = { getFlag: () => undefined };
    const mergerCtx = sessionCtx(workRoot, resolve(workRoot, "runs/merger/session"));
    const judgeCtx = sessionCtx(workRoot, resolve(workRoot, "runs/judge/session"));

    // 1) role input, no work-root files → authority = input bytes
    const inputOnly = await loadNavigatorWorkContext(mergerPi, { context: mergerCtx, role: "merger" });
    assert.equal(inputOnly.authority, inputBytes);
    assert.equal(inputOnly.subject, inputBytes);
    assert.equal(inputOnly.subjectProvenance, "role_input");

    // 2) both present → input wins
    await writeFile(resolve(workRoot, "authority.md"), "work-root file authority\n", "utf8");
    const both = await loadNavigatorWorkContext(mergerPi, { context: mergerCtx, role: "merger" });
    assert.equal(both.authority, inputBytes);
    assert.notEqual(both.authority, "work-root file authority\n");

    // 3) valid input + unreadable/directory authority.md still succeeds verbatim (true short-circuit)
    await rm(resolve(workRoot, "authority.md"));
    await mkdir(resolve(workRoot, "authority.md"), { recursive: true });
    const withDirectoryAuthority = await loadNavigatorWorkContext(mergerPi, { context: mergerCtx, role: "merger" });
    assert.equal(withDirectoryAuthority.authority, inputBytes);
    assert.equal(withDirectoryAuthority.subject, inputBytes);
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
        },
      async () => { if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir; }
    );
  });
});

test("prepare tool accepts free-form prose once without retry (#959)", async () => {
  const accepted: unknown[] = [];
  const tool = createNavigatorPrepareTool((value) => { accepted.push(value); });

  const proseOnly = { prose: "下一步送 fixer apply" };
  const first = await tool.execute("prose-only", proseOnly as never, undefined, undefined, {} as never);
  assert.equal(accepted.length, 1, "prose batch must be accepted");
  assert.equal((first as { terminate?: boolean }).terminate, true);

  // Free-form object without prose field must not open a correction loop.
  const freeForm = {
    role: "reviewer",
    command: "ak-role reviewer",
    reason: "Usage: model prose must not gate acceptance",
  };
  const second = await tool.execute("free-form", freeForm as never, undefined, undefined, {} as never);
  assert.deepEqual(accepted, [proseOnly, freeForm]);
  assert.equal((second as { terminate?: boolean }).terminate, true);
  assert.deepEqual((second as { details?: unknown }).details, freeForm);
});

test("prepare provider schema admits object-root free-form through real Tool validation (#959)", async () => {
  const accepted: unknown[] = [];
  const tool = createNavigatorPrepareTool((value) => { accepted.push(value); });
  // Production gate is pi-ai validateToolArguments against tool.parameters — not direct execute.
  // Nested advisory shape must never reject before the unique execute path.
  const payloads = [
    { name: "prose:string", args: { prose: "送大理寺" } },
    { name: "free-form role", args: { role: "judge", reason: "核验" } },
    { name: "empty object", args: {} },
    { name: "legacy candidates", args: { candidates: [{ next: { role: "judge" } }] } },
  ] as const;
  for (const payload of payloads) {
    const validated = validateToolArguments(tool as never, {
      id: payload.name,
      name: tool.name,
      arguments: structuredClone(payload.args) } as never);
    const result = await tool.execute(payload.name, validated as never, undefined, undefined, {} as never);
    assert.equal((result as { terminate?: boolean }).terminate, true, `${payload.name} must terminate once`);
  }
  assert.equal(accepted.length, payloads.length, "every object-root payload reaches the unique execute sink exactly once");

  await withTempRoot("navigator-schema-gate-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, root);
      nav.prepare();
      await settleWithAdvice(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        { prose: "下一步送 fixer apply" },
        "live-prose",
      );
      assert.equal(events[0]?.disposition, "advice");
      assert.equal(events[0]?.prose, "下一步送 fixer apply");
    }

    // Empty body → affirmative no-advice (not unavailable for missing next).
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, root);
      nav.prepare();
      await settleWithAdvice(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        {},
        "empty",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.disposition, "no-advice");
    }
  });
});

test("#959 prose prepare settles advice; empty body is no-advice not unavailable", async () => {
  await withTempRoot("navigator-prose-only-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, root);
      nav.prepare();
      await settleWithAdvice(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        { prose: "下一步送 fixer apply" },
        "prose-only",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "advice");
      assert.equal(events[0].prose, "下一步送 fixer apply");
      assert.equal(
        harness.entries.some((entry: any) => entry.customType === "ak-navigator-settlement" && entry.data?.kind === "accepted"),
        true,
      );
      assert.equal(harness.prompts(), 1, "prepare is the sole model round; settle only picks");
      const preparePrompt = harness.promptTexts()[0];
      assert.equal(typeof preparePrompt, "string");
      const fed = JSON.parse(preparePrompt ?? "") as Record<string, unknown>;
      assert.equal(fed.kind, "prepare");
      assert.equal(fed.subjectKey, "/repo/.ak/work/issues/28");
      assert.equal(typeof fed.invocationId, "string");
      assert.equal("status" in fed, false, "prepare does not know the outcome yet");
    }

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, root);
      nav.prepare();
      // The injected object is this test's own known input: its content must
      // reach the downstream event unchanged, not merely be classified advice.
      const advice = { reason: "still thinking", role: "not-a-role" };
      await settleWithAdvice(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        advice,
        "legacy-free-form",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "advice");
      assert.deepEqual(JSON.parse(events[0].prose), advice);
    }

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, root);
      nav.prepare();
      await settleWithAdvice(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        { prose: "  " },
        "empty-prose",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "no-advice");
    }
  });
});

test("registry still lists every packaged role as a navigator target (#959 prose keeps help surface)", async () => {
  // Registry output tools are contract-owned. Every public role remains a lawful
  // navigator help target (#675 — no nested-only seat exclusions).
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
      { role: "notary", outputTool: NOTARY_OUTPUT_TOOL_NAME },
      { role: "countersign", outputTool: COUNTERSIGN_OUTPUT_TOOL_NAME },
      { role: "secretariat", outputTool: "ak_secretariat_output" },
      { role: "gleaner-left", outputTool: GLEANER_LEFT_OUTPUT_TOOL_NAME },
      { role: "inspector", outputTool: INSPECTOR_OUTPUT_TOOL_NAME },
      { role: "gatekeeper", outputTool: "ak_gatekeeper_output" },
      { role: "navigator", outputTool: "ak_navigator_output" },
      { role: "auditor", outputTool: COUNTERSIGN_OUTPUT_TOOL_NAME },
      { role: "diarist", outputTool: "ak_diarist_output" },
    ],
  );
});

test("#959 empty prepare body is no-advice; explicit prose settles as advice without invented next", async () => {
  await withTempRoot("navigator-no-invented-route-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    async function settleEmptyAdvice(role: "fixer" | "coder", batch: unknown) {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = createNavigatorAttendance({
        context: context(root), role, phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
        subject: "work", authority: "owner decision",
        createSession: harness.factory,
        modelSettingPath: setting,
        onEvent: async (event) => { events.push(event); } });
      nav.prepare();
      await settleWithAdvice(nav, harness, { kind: "accepted", role, phase: "apply", status: "completed" }, batch, "batch");
      return events[0];
    }

    // Empty advice → no-advice; never invent a next seat.
    const fixerEmpty = await settleEmptyAdvice("fixer", {});
    assert.equal(fixerEmpty?.disposition, "no-advice");
    assert.equal(fixerEmpty?.prose, undefined);

    const coderEmpty = await settleEmptyAdvice("coder", { prose: "   " });
    assert.equal(coderEmpty?.disposition, "no-advice");
    assert.equal(coderEmpty?.prose, undefined);

    // Explicit prose settles as advice.
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(root), role: "fixer", phase: "apply", subjectKey: "/repo/.ak/work/issues/28",
      subject: "work", authority: "Controlling authority names coder apply next.",
      createSession: harness.factory,
      modelSettingPath: setting,
      onEvent: async (event) => { events.push(event); } });
    nav.prepare();
    await settleWithAdvice(
      nav,
      harness,
      { kind: "accepted", role: "fixer", phase: "apply", status: "completed" },
      { prose: "authority names coder apply next" },
      "explicit",
    );
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "authority names coder apply next");
  });
});

test("#959 package does not keep a prior-advice ledger; host session owns continuity", async () => {
  await withTempRoot("navigator-no-prior-advice-ledger-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, root);

    nav.prepare();
    await settleWithAdvice(
      nav,
      harness,
      { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
      { prose: "第一次建议" },
      "first-advice",
    );
    assert.equal(events[0]?.disposition, "advice");

    nav.prepare();
    await settleWithAdvice(
      nav,
      harness,
      { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
      { prose: "第二次建议" },
      "second-advice",
    );
    const context = harness.retainedContext();
    assert.equal(
      "priorAdvice" in (context ?? {}),
      false,
      "package must not project a prior-advice field",
    );

    assert.equal(events[1]?.disposition, "advice");
    assert.equal(
      harness.entries.some((entry: any) => entry.customType === "ak-navigator-prior-advice"),
      false,
      "package must not book ak-navigator-prior-advice",
    );
  });
});
test("#1187 empty authority still prepares from identity alone", async () => {
  await withTempRoot("navigator-empty-authority-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(root),
      role: "judge",
      phase: null,
      subjectKey: "/repo/.ak/work",
      subject: "work subject: /repo/.ak/work",
      authority: "",
      modelSettingPath: setting,
      createSession: harness.factory,
      onEvent: async (event) => { events.push(event); } });
    await prepareWithAdvice(nav, harness, { prose: "下一步送大理寺" });
    assert.equal(harness.prompts(), 1, "identity-only prepare must open the model round");
    const fed = JSON.parse(harness.promptTexts()[0] ?? "") as Record<string, unknown>;
    assert.equal(fed.kind, "prepare");
    assert.equal(fed.role, "judge");
    assert.equal(fed.subjectKey, "/repo/.ak/work");
    assert.equal("subject" in fed, false);
    assert.equal("authority" in fed, false);
    await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "下一步送大理寺");
  });
});

test("#1187 public auto prepare drops parent dispatch while admitted instruction stays intact", async () => {
  await withTempRoot("navigator-no-parent-dispatch-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));

    const runDir = join(root, "run-public-judge");
    await mkdir(join(runDir, "session"), { recursive: true });
    const parentDispatch = [
      "#1843 御史台 correctness 审查",
      "复杂度是重点、功能次要",
      "MING_SIM_CLAUDE_BIN=/usr/bin/false",
    ].join("\n");
    seedCurrentSection(runDir, "admitted", {
      role: "judge",
      runId: "run-judge-1",
      instruction: parentDispatch,
      instructionEmpty: false,
      attachments: [],
    });

    const work = await loadNavigatorWorkContext(
      { getFlag: () => undefined },
      {
        context: {
          cwd: root,
          runDirectory: runDir,
          sessionManager: { getSessionDir: () => join(runDir, "session") },
        } as never,
        role: "judge",
      },
    );
    assert.equal(work.subjectProvenance, "role_input");
    assert.equal(work.subject.includes(parentDispatch), false);
    assert.equal(work.authority.includes("MING_SIM_CLAUDE_BIN"), false);

    // Parent admitted instruction remains the parent role's own dispatch surface.
    const { loadAdmittedJudgeRequest } = await import("../../src/public-cli/invocation.ts");
    const admitted = await loadAdmittedJudgeRequest(runDir);
    assert.equal(admitted?.instruction, parentDispatch);

    const harness = sessionHarness();
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: { cwd: root, home: root } as never,
      role: "judge",
      phase: null,
      subjectKey: work.subjectKey,
      subject: work.subject,
      authority: work.authority,
      modelSettingPath: setting,
      createSession: harness.factory,
      onEvent: async (event) => { events.push(event); },
    });
    await prepareWithAdvice(nav, harness, byStatusAdvice({
      converged: "交卷送大理寺",
      escalate: "按诊断重跑",
    }));
    const fed = JSON.parse(harness.promptTexts()[0] ?? "") as Record<string, unknown>;
    assert.equal(fed.kind, "prepare");
    assert.equal(fed.role, "judge");
    assert.equal(fed.subjectKey, work.subjectKey);
    assert.equal("subject" in fed, false);
    assert.equal("authority" in fed, false);
    const wire = harness.promptTexts()[0] ?? "";
    assert.equal(wire.includes(parentDispatch), false);
    assert.equal(wire.includes("MING_SIM_CLAUDE_BIN"), false);
    assert.equal(wire.includes("复杂度是重点"), false);

    await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "交卷送大理寺");
  });
});

test("public admitted section projects typed subject/authority; missing/malformed stay source=context", async () => {
  await withTempRoot("navigator-admitted-request-", async (root) => {
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
    return withPrimaryAwareCleanup(
      async () => {

    const runDir = join(root, "run-public-judge");
    await mkdir(runDir, { recursive: true });
    const sessionDir = join(runDir, "session");
    await mkdir(sessionDir, { recursive: true });
    const prose = "Canonical nonblank prose Judge request for navigation.";
    seedCurrentSection(runDir, "admitted", {
      role: "judge",
      runId: "run-public-1",
      instruction: prose,
      instructionEmpty: false,
      attachments: [] });

    const judgePi = { getFlag: () => undefined };
    const judgeCtx = (runDirectory: string) => ({
      cwd: root,
      runDirectory,
      sessionManager: { getSessionDir: () => join(runDirectory, "session") },
    } as never);

    delete process.env.AK_ROLE_RUN_DIR;
    const loaded = await loadNavigatorWorkContext(judgePi, { context: judgeCtx(runDir), role: "judge" });
    // #1187: public admitted instruction starts prepare by identity; parent prose is not material.
    assert.equal(loaded.subject.includes(prose), false);
    assert.equal(loaded.authority.includes(prose), false);
    assert.equal(loaded.authority, "");
    assert.equal(loaded.subjectProvenance, "role_input");
    assert.ok(loaded.subjectKey.length > 0);

    // Missing admitted request → typed context unavailable (not model/session/transport).
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx(join(root, "missing-run")), role: "judge" }),
      (error: unknown) =>
        error instanceof NavigatorUnavailableError &&
        error.unavailableSource === "context" &&
        error.unavailableCause === "context",
    );

    // Malformed admitted request JSON → same context classification.
    const badRun = join(root, "bad-run");
    await mkdir(badRun, { recursive: true });
    // Whole-file corruption: current.json is the single carrier of the admitted section.
    await writeFile(join(badRun, "current.json"), "{not-json", "utf8");
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx(badRun), role: "judge" }),
      (error: unknown) =>
        error instanceof NavigatorUnavailableError && error.unavailableSource === "context",
    );

    // Structurally invalid admitted request (role without public-instruction subject) → context unavailable.
    const wrongRoleRun = join(root, "wrong-role-run");
    await mkdir(wrongRoleRun, { recursive: true });
    seedCurrentSection(wrongRoleRun, "admitted", {
      role: "merger",
      instruction: prose,
      instructionEmpty: false,
      attachments: [] });
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx(wrongRoleRun), role: "judge" }),
      (error: unknown) =>
        error instanceof NavigatorUnavailableError && error.unavailableSource === "context",
    );

    // Empty public request keeps placeholder work context (no invented task prose).
    const emptyRun = join(root, "empty-run");
    await mkdir(emptyRun, { recursive: true });
    seedCurrentSection(emptyRun, "admitted", {
      role: "judge",
      instruction: "",
      instructionEmpty: true,
      attachments: [] });
    const empty = await loadNavigatorWorkContext(judgePi, { context: judgeCtx(emptyRun), role: "judge" });
    assert.equal(empty.subjectProvenance, "placeholder");
    assert.equal(empty.authority, "");
    assert.equal(empty.subject.includes(prose), false);
        },
      async () => { if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir; }
    );
  });
});

test("station-child shared lifecycle omits Navigator attendance; top-level still creates it", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");

  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    await withActivationHome({ prefix: "ak-nav-station-child-" }, async ({ home }) => {
      // The public countersign and inner-gate notary use caller-set models (#178).
      const { runAkRole } = await import("../../src/public-cli/cli.ts");
      await runAkRole(
        ["config", "set",
          "countersign", "test/caller-seat:high",
          "judge", "test/caller-seat:high",
          "notary", "test/caller-seat:high",
          "gatekeeper", "test/caller-seat:high",
        ],
        { packageRoot, home, io: { stdout() {}, stderr() {} } },
      );
      async function attendanceCreatedFromTurn(request: RoleTurnRequest): Promise<boolean> {
        const runDir = request.runDirectory;
        await mkdir(join(runDir, "session"), { recursive: true });
        process.env.AK_ROLE_RUN_DIR = runDir;
        let created = false;
        const flags = projectActivationFlags(request);
        const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
        const tools: unknown[] = [];
        const pi = {
          registerFlag() {},
          getFlag(name: string) {
            return flags.get(name);
          },
          on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
            handlers.set(name, handler);
          },
          registerTool(tool: unknown) {
            tools.push(tool);
          },
          getAllTools() {
            return tools;
          },
          setActiveTools() {},
          getActiveTools() {
            return tools;
          },
          appendEntry() {},
        };
        const envelopeHost: RoleEnvelopeHost = {
          host: pi as RoleHost,
          appendEntry: pi.appendEntry,
          sendMessage() {},
          startKeepalive() {},
          stopKeepalive() {},
        };
        createRoleRuntimeExtension({
          loadRoleSoul: async (role) => {
            if (role === "countersign") return "COUNTERSIGN LAW";
            if (role === "notary") return "NOTARY LAW";
            return "JUDGE LAW";
          },
          loadNotarySourceRun: async (path: string) => ({
            runDirectory: path,
            runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
            role: "judge" as const,
          }),
          loadNavigatorWorkContext: async () => ({
            subjectKey: `${runDir}/work`,
            subject: "work",
            authority: "authority",
            subjectProvenance: "role_input" as const,
          }),
          createNavigatorAttendance: () => {
            created = true;
            return {
              prepare() {},
              setWorkContext() {},
              warmHelp() {},
              isPreparing: () => false,
              settle: async () => {},
              dispose() {},
            };
          },
        })(envelopeHost);
        const sessionManager = SessionManager.create(home, join(runDir, "session"));
        await handlers.get("session_start")?.({}, {
          cwd: home,
          sessionManager,
          abort() {},
        });
        return created;
      }

      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedRoleRepo(project);

      const captured: RoleTurnRequest[] = [];
      const recordingHost = (scripted: ReturnType<typeof roleTurnHostFromLegacyPiRunner>) => ({
        async executeTurn(request: RoleTurnRequest) {
          captured.push(request);
          return scripted.executeTurn(request);
        },
      });

      const countersignBase = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const roleIndex = args.indexOf("--ak-role");
          const role = roleIndex >= 0 ? args[roleIndex + 1] : undefined;
          if (role === "notary") {
            return scriptedTerminatingToolSession({
              role: "notary",
              toolName: NOTARY_OUTPUT_TOOL_NAME,
              details: { status: "converged", findings: [] },
            })(args, options);
          }
          return scriptedTerminatingToolSession({
            role: "countersign",
            toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
            details: { status: "converged", note: "署" },
          })(args, options);
        },
      });
      const countersignHost = recordingHost(countersignBase);
      const hostAdapters = [
        { name: "pi" as const, create: () => ({ ok: true as const, host: countersignHost }) },
        { name: "grok-build" as const, create: () => ({ ok: true as const, host: countersignHost }) },
      ];
      const { stdout, stderr, io } = captureIo();
      const countersignResult = await runPublicInstructionSeat(
        ["裁：继续审票 #582 是否足以开工。"],
        {
          home,
          agentDir: join(home, ".pi"),
          packageRoot,
          cwd: project,
          principalAuthority: piDurablePrincipalAuthority,
          sessionAppender: appendPiSessionCustomEntry,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: countersignHost,
          hostAdapters,
          createRunId: () => "01a0sign00-0000-7000-8000-00000000a1b",
        },
        io,
        "countersign",
        (args) => parsePublicSeatArgv("countersign", args),
      );
      assert.equal(countersignResult.exitCode, 0, stderr.join("") || stdout.join(""));
      const topLevel = captured.find((request) => request.activation.role === "countersign");
      assert.ok(topLevel, "countersign public entry must dispatch a top-level turn");
      assert.equal(captured.some((request) => request.activation.role === "diarist"), false,
        "countersign court must not summon a diarist child");

      captured.length = 0;
      const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 582 });
      const notaryBase = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: scriptedTerminatingToolSession({
          role: "notary",
          toolName: NOTARY_OUTPUT_TOOL_NAME,
          details: { status: "converged", findings: [] },
        }),
      });
      const notaryHost = recordingHost(notaryBase);
      const projected = await projectGatekeeperRun({
        context: {
          cwd: project,
          sessionManager: {
            getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
            getEntries: () => [
              {
                type: "message",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "call-a1b",
                      name: "ak_submission_output",
                      arguments: { status: "converged", note: "seat" },
                    },
                  ],
                },
              },
            ],
          },
        } as never,
        subject: { kind: "countersign_verdict" },
        runDirectory: sourceRunPath,
      summonOfficer: createDefaultGateOfficerSummon({
        cwd: project,
        home,
        packageRoot,
        roleTurnHost: notaryHost,
        createRunId: () => "01a082100-0000-7000-8000-0000000na1b",
      }),
    });
      assert.equal(projected.result.status, "converged");
      const notaryChild = captured.find((request) => request.activation.role === "notary");
      assert.ok(notaryChild, "inner-gate summons must dispatch a notary child turn");

      assert.equal(
        await attendanceCreatedFromTurn(topLevel),
        true,
        "top-level public activation must construct Navigator attendance",
      );
      assert.equal(
        await attendanceCreatedFromTurn(notaryChild),
        false,
        "inner-gate station child must not construct Navigator attendance",
      );
    });
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
  }
});

test("host-neutral envelope drives shared registration and session lifecycle", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");

  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    const prose = "Admitted instruction prose observed by Navigator attendance.";
    await withActivationHome({ prefix: "ak-nav-admitted-" }, async ({ home }) => {
      const runDir = join(home, ".ak-roles", "books", basename(home), "runs", "judge-admitted");
      await mkdir(join(runDir, "session"), { recursive: true });
      process.env.AK_ROLE_RUN_DIR = runDir;
      let observed: { subject?: string; authority?: string; subjectKey?: string } | undefined;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
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
        getActiveTools() { return []; },
        appendEntry() {} };

      const envelopeHost: RoleEnvelopeHost = {
        host: pi as RoleHost,
        appendEntry: pi.appendEntry,
        sendMessage() {},
        startKeepalive() {},
        stopKeepalive() {} };
      createRoleRuntimeExtension({
        loadRoleSoul: async () => "JUDGE LAW",
        loadNavigatorWorkContext: async () => ({
          subjectKey: `${runDir}/work`,
          subject: prose,
          authority: prose,
          subjectProvenance: "role_input" }),
        createNavigatorAttendance: (options) => {
          observed = {
            subject: options.subject,
            authority: options.authority,
            subjectKey: options.subjectKey };
          return {
            prepare() {},
            setWorkContext() {},
            warmHelp() {},
            isPreparing: () => false,
            settle: async () => {},
            dispose() {} };
        } })(envelopeHost);

      const sessionDir = join(runDir, "session");
      await mkdir(sessionDir, { recursive: true });
      const sessionManager = SessionManager.create(home, sessionDir);
      await handlers.get("session_start")?.({}, {
        cwd: home,
        sessionManager,
        abort() {} });

      assert.ok(observed, "Navigator attendance must be constructed");
      assert.equal(observed.subject, prose);
      assert.equal(observed.authority, prose);
      assert.ok(String(observed.subjectKey).length > 0);
    });
  } finally {
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
  }
});

test("bare developer prompt recovers Navigator work context poisoned at session_start", async () => {
  const { basename } = await import("node:path");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
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
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
      appendEntry() {} };

    let latestContext: {
      subject?: string;
      authority?: string;
      subjectProvenance?: string;
      contextError?: unknown;
    } = {};
    let prepareCalls = 0;
    const setContexts: Array<Record<string, unknown>> = [];

    createPiRoleRuntimeExtension({
      loadRoleSoul: async () => "JUDGE LAW",
      // Production soft miss: session_start has no materials yet (no throw/poison).
      loadNavigatorWorkContext: async () => ({
        subjectKey: join(home, ".ak/work"),
        subject: `work subject: ${join(home, ".ak/work")}`,
        authority: "",
        subjectProvenance: "placeholder" as const }),
      createNavigatorAttendance: (options) => {
        latestContext = {
          subject: options.subject,
          authority: options.authority,
          subjectProvenance: "placeholder",
          contextError: options.contextError };
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
              contextError: next.contextError };
          },
          warmHelp() {},
          isPreparing: () => false,
          settle: async () => {},
          dispose() {} };
      } })(pi as never);

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

/** Sole #959 grace case: hung nest summon + real session_start/tool_result/shutdown. */
async function withNavigatorInfraGraceEnvelope(
  options: {
    readonly prefix: string;
    readonly runName: string;
    readonly subject: string;
    readonly authority: string;
  },
  run: (harness: {
    readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
    readonly sent: Array<{ customType?: string; details?: unknown }>;
    readonly ctx: { cwd: string; sessionManager: unknown; abort(): void; runDirectory: string };
    readonly seenSignal: () => AbortSignal | undefined;
    readonly summonStarted: () => boolean;
    readonly nestStopped: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  await withActivationHome({ prefix: options.prefix }, async ({ home }) => {
    seedGitRepository(home);
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      join(home, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const modelSettingPath = join(home, "navigator-model.json");
    await writeFile(modelSettingPath, `${JSON.stringify({ model: "provider/model" })}\n`);

    const runDir = join(home, ".ak-roles", "books", basename(home), "runs", options.runName);
    await mkdir(join(runDir, "session"), { recursive: true });
    process.env.AK_ROLE_RUN_DIR = runDir;

    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const sent: Array<{ customType?: string; details?: unknown }> = [];
    let seenSignal: AbortSignal | undefined;
    let summonStarted = false;
    let nestStopped = false;
    const summon = async (summonOptions: {
      readonly role: "navigator";
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly home?: string;
      readonly resumeRunId?: string;
      readonly signal?: AbortSignal;
    }) => {
      seenSignal = summonOptions.signal;
      summonStarted = true;
      assert.ok(seenSignal, "shared attendance must forward cancel signal into summon");
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          nestStopped = true;
          reject(seenSignal?.reason ?? new Error("navigator nest aborted"));
        };
        if (seenSignal!.aborted) {
          onAbort();
          return;
        }
        seenSignal!.addEventListener("abort", onAbort, { once: true });
      });
      return { exitCode: 1 };
    };

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
      getActiveTools() {
        return [];
      },
      appendEntry() {},
    };
    const envelopeHost: RoleEnvelopeHost = {
      host: pi as RoleHost,
      appendEntry: pi.appendEntry,
      sendMessage(message) {
        sent.push(message as { customType?: string; details?: unknown });
      },
      startKeepalive() {},
      stopKeepalive() {},
    };
    createRoleRuntimeExtension({
      loadRoleSoul: async () => "JUDGE LAW",
      loadNavigatorWorkContext: async () => ({
        // Concrete subject starts parallel prepare on session_start; grace aborts
        // that hung nest at settle — settle itself does not start a model round (#1160).
        subjectKey: `${runDir}/work`,
        subject: options.subject,
        authority: options.authority,
        subjectProvenance: "role_input" as const,
      }),
      createNavigatorAttendance: (attendanceOptions) =>
        createNavigatorAttendance({
          context: attendanceOptions.context,
          role: attendanceOptions.role,
          phase: attendanceOptions.phase,
          subjectKey: attendanceOptions.subjectKey,
          subject: attendanceOptions.subject,
          authority: attendanceOptions.authority,
          invocationId: attendanceOptions.invocationId,
          ...(attendanceOptions.contextError === undefined
            ? {}
            : { contextError: attendanceOptions.contextError }),
          modelSettingPath,
          createSession: async (sessionOptions) => {
            const created = await createNativeNavigatorSessionFactory({
              summonPublicRole: summon,
              hostRunResumable: async () => false,
            })(sessionOptions);
            const innerDispose = created.dispose.bind(created);
            return {
              ...created,
              dispose: async () => {
                await innerDispose();
                // Hang after real dispose work so awaiting teardown would re-block the court.
                await new Promise<void>(() => {});
              },
            };
          },
          onEvent: attendanceOptions.onEvent,
        }),
    })(envelopeHost);

    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessionManager = SessionManager.create(home, join(runDir, "session"));
    const ctx = { cwd: home, sessionManager, abort() {}, runDirectory: runDir };
    await run({
      handlers,
      sent,
      ctx,
      seenSignal: () => seenSignal,
      summonStarted: () => summonStarted,
      nestStopped: () => nestStopped,
    });
  });
}

test("#959 post-role grace aborts hung nest; session_shutdown does not re-block", async (t) => {
  // Real shared entry: session_start → infrastructure settlement → attendance settle →
  // public-session summon (listens to HostContext.signal) → grace dispose aborts nest →
  // session_shutdown must return without awaiting nested teardown (#959 reopen).
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    await withNavigatorInfraGraceEnvelope(
      {
        prefix: "ak-nav-infra-grace-",
        runName: "judge-infra-grace",
        subject: "infra grace subject",
        authority: "infra grace authority",
      },
      async ({ handlers, sent, ctx, seenSignal, summonStarted, nestStopped }) => {
        await handlers.get("session_start")?.({}, ctx);

        await waitForEventLoopCondition(() => summonStarted(), {
          label: "parallel prepare must start nested public summon",
          timeoutMs: 2_000,
        });
        assert.equal(seenSignal()?.aborted, false, "nest stays live until grace dispose");

        const toolResult = handlers.get("tool_result");
        assert.ok(toolResult, "shared envelope must register tool_result");
        const pending = Promise.resolve(
          toolResult(
            {
              toolCallId: "infra-hung",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: true,
              details: buildNavigatorInfrastructureFailureFact(),
              content: [],
            },
            ctx,
          ),
        );
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        assert.equal(settled, false, "hung prepare must still be inside grace");
        assert.equal(seenSignal()?.aborted, false, "nest stays live until grace dispose");

        t.mock.timers.tick(NAVIGATOR_POST_ROLE_GRACE_MS);
        await waitForEventLoopCondition(() => settled && nestStopped(), {
          label: "post-role grace must release parent and abort nested summon",
          timeoutMs: 1_000,
        });
        assert.equal(seenSignal()?.aborted, true, "grace dispose must abort nested summon signal");
        assert.equal(nestStopped(), true, "nested summon must observe abort and stop");

        await handlers.get("agent_settled")?.({}, ctx);
        const presentation = sent.find((message) => message.customType === NAVIGATOR_EVENT_TYPE);
        assert.ok(presentation, "grace timeout must project navigator attendance");
        assert.equal(
          (presentation.details as { disposition?: string } | undefined)?.disposition,
          "unavailable",
        );
        assert.equal(
          (presentation.details as { unavailableReason?: string } | undefined)?.unavailableReason,
          "Navigator exceeded post-role delivery grace",
        );

        // Hung closing must not block shutdown (awaiting dispose would hang).
        let shutdownDone = false;
        const shutdown = Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)).then(
          () => {
            shutdownDone = true;
          },
        );
        await flushEventLoopTurns(5);
        assert.equal(shutdownDone, true, "session_shutdown must finish without awaiting teardown");
        await shutdown;
      },
    );
  } finally {
    t.mock.timers.reset();
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
  }
});
