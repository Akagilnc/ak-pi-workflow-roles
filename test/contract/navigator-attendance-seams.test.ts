// #420 整改拆分：接缝与恢复家族
// #178: restore prepare consumers with per-case seat fixture + explicit context.home.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import { createNativeNavigatorSessionFactory, createNavigatorAttendance, createNavigatorPrepareTool, NAVIGATOR_PREPARE_TOOL_NAME, NavigatorUnavailableError, NAVIGATOR_TARGETS } from "../../src/navigator-attendance.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "../../src/diarist-contracts.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import { createDefaultGateOfficerSummon } from "../../src/gatekeeper-pass-envelope.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { parseCountersignArgv } from "../../src/public-cli/invocation.ts";
import { runPublicCountersign } from "../../src/public-cli/countersign-run.ts";
import { projectActivationFlags } from "../../src/role-activation-flags.ts";
import { ensureTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
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
} from "../helpers/navigator-attendance-kit.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository, withActivationHome } from "../helpers/pi-test-harness.ts";
import { withTempRoot, withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";

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
    const packetPath = resolve(workRoot, "fix-packet.md");
    const packetBytes = "# Fix packet\n\nCourt-binding authority for issue 91.\n";
    await writeFile(packetPath, packetBytes, "utf8");

    const sessionCtx = (cwd: string, sessionDir: string) => ({
      cwd,
      sessionManager: { getSessionDir: () => sessionDir } }) as never;
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
  assert.equal(accepted.length, 2, "free-form shape still accepted once");
  assert.equal((second as { terminate?: boolean }).terminate, true);
  assert.equal((second as { details?: { error?: string } }).details?.error, undefined);
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
      const nav = await attendance(setting, harness, events, undefined, root);
      nav.prepare();
      const waiting = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      while (harness.tool() === undefined || harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
      const usableArgs = { prose: "下一步送 fixer apply" };
      const validated = validateToolArguments(harness.tool() as never, {
        id: "live-prose",
        name: NAVIGATOR_PREPARE_TOOL_NAME,
        arguments: structuredClone(usableArgs) } as never);
      await harness.tool().execute("live-prose", validated as never, undefined, undefined, {} as never);
      harness.release();
      await waiting;
      assert.equal(events[0]?.disposition, "advice");
      assert.equal(events[0]?.prose, "下一步送 fixer apply");
    }

    // Empty body → affirmative no-advice (not unavailable for missing next).
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, undefined, root);
      nav.prepare();
      const waiting = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      while (harness.tool() === undefined || harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
      const validated = validateToolArguments(harness.tool() as never, {
        id: "empty",
        name: NAVIGATOR_PREPARE_TOOL_NAME,
        arguments: {} } as never);
      await harness.tool().execute("empty", validated as never, undefined, undefined, {} as never);
      harness.release();
      await waiting;
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
      const nav = await attendance(setting, harness, events, undefined, root);
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
      assert.equal(harness.retainedContext()?.currentSettlement?.kind, "accepted");
      assert.equal(harness.prompts(), 1, "one settlement-bound advice prompt");
    }

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, undefined, root);
      nav.prepare();
      await settleWithAdvice(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        { reason: "still thinking", role: "not-a-role" },
        "legacy-free-form",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "advice");
      assert.ok(typeof events[0].prose === "string" && events[0].prose.includes("still thinking"));
    }

    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events, undefined, root);
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
      { role: "auditor", outputTool: "ak_auditor_output" },
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
        loadSoul: async () => "route judgment",
        loadRoleHelp: async (r) => `help ${r}`,
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
      loadSoul: async () => "route judgment",
      loadRoleHelp: async (r) => `help ${r}`,
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
    const nav = await attendance(setting, harness, events, undefined, root);

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
    const waiting = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    while (harness.prompts() < 2 || harness.tool() === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const context = harness.retainedContext();
    assert.equal(
      "priorAdvice" in (context ?? {}),
      false,
      "package must not project a prior-advice field",
    );
    await harness.tool().execute("second-advice", { prose: "第二次建议" }, undefined, undefined, {} as never);
    harness.release();
    await waiting;

    assert.equal(events[1]?.disposition, "advice");
    assert.equal(
      harness.entries.some((entry: any) => entry.customType === "ak-navigator-prior-advice"),
      false,
      "package must not book ak-navigator-prior-advice",
    );
  });
});
test("empty authority at prepare is honest context unavailable", async () => {
  await withTempRoot("navigator-empty-authority-", async (root) => {
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: context(),
      role: "judge",
      phase: null,
      subjectKey: "/repo/.ak/work",
      subject: "work subject: /repo/.ak/work",
      authority: "",
      loadSoul: async () => "route law",
      loadRoleHelp: async (role) => `Usage: ak-role ${role}`,
      modelSettingPath: setting,
      createSession: async () => {
        throw new Error("session must not open without authority");
      },
      onEvent: async (event) => { events.push(event); } });
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "judge", phase: null, status: "converged" });
    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "unavailable");
    assert.equal(events[0].unavailableSource, "context");
    assert.equal(events[0].unavailableCause, "context");
    assert.equal(events[0].prose, undefined);
    assert.notEqual(events[0].unavailableReason, undefined);
    });
});


test("public admitted-request projects typed subject/authority; missing/malformed stay source=context", async () => {
  await withTempRoot("navigator-admitted-request-", async (root) => {
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
    return withPrimaryAwareCleanup(
      async () => {

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
        attachments: [] }),
      "utf8",
    );

    const judgePi = { getFlag: () => undefined };
    const judgeCtx = (runDirectory: string) => ({
      cwd: root,
      runDirectory,
      sessionManager: { getSessionDir: () => join(runDirectory, "session") },
    } as never);

    delete process.env.AK_ROLE_RUN_DIR;
    const loaded = await loadNavigatorWorkContext(judgePi, { context: judgeCtx(runDir), role: "judge" });
    assert.equal(loaded.subject, prose);
    assert.equal(loaded.authority, prose);
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
    await writeFile(join(badRun, "admitted-request.json"), "{not-json", "utf8");
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx(badRun), role: "judge" }),
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
        attachments: [] }),
      "utf8",
    );
    await assert.rejects(
      () => loadNavigatorWorkContext(judgePi, { context: judgeCtx(wrongRoleRun), role: "judge" }),
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
        attachments: [] }),
      "utf8",
    );
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
      // Nested diarist/countersign need caller-set models (#178).
      const { runAkRole } = await import("../../src/public-cli/cli.ts");
      await runAkRole(
        ["config", "set",
          "countersign", "test/caller-seat:high",
          "diarist", "test/caller-seat:high",
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
          loadJudgeSoul: async () => "JUDGE LAW",
          loadCountersignSoul: async () => "COUNTERSIGN LAW",
          loadDiaristSoul: async () => "DIARIST LAW",
          loadNotarySoul: async () => "NOTARY LAW",
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
      seedGitRepository(project);
      execFileSync(
        "git",
        ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
        { cwd: project },
      );
      ensureTicketProvenanceVolume(582, project, home);

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
          if (role === "diarist") {
            return scriptedTerminatingToolSession({
              role: "diarist",
              toolName: DIARIST_OUTPUT_TOOL_NAME,
              details: { status: "completed", ticketNumber: 582, sessions: [] },
            })(args, options);
          }
          return scriptedTerminatingToolSession({
            role: "countersign",
            toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
            details: { countersignStatus: "converged", note: "署" },
          })(args, options);
        },
      });
      const countersignHost = recordingHost(countersignBase);
      const hostAdapters = [
        { name: "pi" as const, create: () => ({ ok: true as const, host: countersignHost }) },
        { name: "grok-build" as const, create: () => ({ ok: true as const, host: countersignHost }) },
      ];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const countersignResult = await runPublicCountersign(
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
        { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
        parseCountersignArgv,
      );
      assert.equal(countersignResult.exitCode, 0, stderr.join("") || stdout.join(""));
      const topLevel = captured.find((request) => request.activation.role === "countersign");
      const diaristChild = captured.find((request) => request.activation.role === "diarist");
      assert.ok(topLevel, "countersign public entry must dispatch a top-level turn");
      assert.ok(diaristChild, "countersign court station must dispatch a diarist child turn");

      captured.length = 0;
      const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 582 });
      const notaryBase = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: scriptedTerminatingToolSession({
          role: "notary",
          toolName: NOTARY_OUTPUT_TOOL_NAME,
          details: { status: "pass", findings: [] },
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
                      name: "ak_countersign_output",
                      arguments: { countersignStatus: "converged", note: "seat" },
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
      assert.equal(projected.result.status, "pass");
      const notaryChild = captured.find((request) => request.activation.role === "notary");
      assert.ok(notaryChild, "inner-gate summons must dispatch a notary child turn");

      assert.equal(
        await attendanceCreatedFromTurn(topLevel),
        true,
        "top-level public activation must construct Navigator attendance",
      );
      assert.equal(
        await attendanceCreatedFromTurn(diaristChild),
        false,
        "court diarist station child must not construct Navigator attendance",
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
        loadJudgeSoul: async () => "JUDGE LAW",
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
      loadJudgeSoul: async () => "JUDGE LAW",
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

test("public navigator session takes a seat edit for the next summon instead of failing model", async () => {
  await withTempRoot("navigator-public-seat-", async (root) => {
    const priorHome = process.env.HOME;
    process.env.HOME = root;
    const { savePublicCliConfig } = await import("../../src/public-cli/config.ts");
    const { seedGitRepository } = await import("../helpers/pi-test-harness.ts");
    await withPrimaryAwareCleanup(
      async () => {
        // Durable nest placement is owned by the archivist factory tracer; this case
        // only locks seat-edit-between-prepares. context.home keeps ledger hermetic.
        seedGitRepository(root);
        await savePublicCliConfig(
          { seats: { navigator: { provider: "provider", model: "one" } } },
          root,
        );
        const session = await createNativeNavigatorSessionFactory()({
          context: { cwd: root, home: root, sessionManager: undefined } as never,
          subject: "seat edit between prepares",
          tool: undefined as never,
        });
        // Every prompt is an independent public summon whose nested CLI reads the
        // live seat table (#675 验收② / #617 DK-3): a seat edit between prepares
        // applies on the next summon and never makes attendance unavailable.
        await savePublicCliConfig(
          { seats: { navigator: { provider: "other", model: "two", thinking: "high" } } },
          root,
        );
        await session.setModel?.("other/two:high", "high");
        assert.equal(session.getThinkingLevel?.(), "high");
        await session.dispose();
      },
      async () => {
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
      },
    );
  });
});
