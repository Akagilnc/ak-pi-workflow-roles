// #420 整改拆分：接缝与恢复家族
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createNavigatorAttendance, createNavigatorPrepareTool, NAVIGATOR_PREPARE_TOOL_NAME, NavigatorUnavailableError, NAVIGATOR_TARGETS } from "../../src/navigator-attendance.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { loadNavigatorWorkContext, resolveNavigatorAuthorityMaterial } from "../../extensions/role-runtime.ts";
import { toPiContext } from "../../src/pi/adapter.ts";
import {
  context,
  candidate,
  cleanupTempDir,
  sessionHarness,
  attendance,
  settleAnsweringRebind,
} from "../helpers/navigator-attendance-kit.ts";

test("role-input authority wins verbatim; files fall back; neither is honestly unavailable", async () => {
  assert.equal(resolveNavigatorAuthorityMaterial("packet authority\n", "file authority\n"), "packet authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial("packet authority\n", undefined), "packet authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial(undefined, "file authority\n"), "file authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial("   \n", "file authority\n"), "file authority\n");
  assert.equal(resolveNavigatorAuthorityMaterial(undefined, undefined), undefined);
  assert.equal(resolveNavigatorAuthorityMaterial("", undefined), undefined);

  const root = await mkdtemp(join(tmpdir(), "navigator-input-authority-"));
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  delete process.env.AK_ROLE_RUN_DIR;
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
      const usableArgs = {
        candidates: [{
          next: { role: "fixer", phase: "apply" },
          route: "not-an-array",
          matches: "not-an-object",
          reason: 7,
        }],
      };
      const malformed = validateToolArguments(harness.tool() as never, {
        id: "live-usable",
        name: NAVIGATOR_PREPARE_TOOL_NAME,
        arguments: structuredClone(usableArgs),
      } as never);
      await harness.tool().execute("live-usable", malformed as never, undefined, undefined, {} as never);
      harness.release();
      // Malformed matches normalize away → unmatched → one settlement-bound rebind; next still passes through.
      await settleAnsweringRebind(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        malformed,
        "live-usable-rebind",
      );
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
      // No usable next → no rebind; settles unavailable immediately.
      await settleAnsweringRebind(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        validated,
        `${name}-rebind`,
      );
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
    // Unmatched direction-only is settlement-rebound once, then passed through as-is.
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      const directionOnly = { candidates: [{ next: { role: "fixer", phase: "apply" } }] };
      await harness.tool().execute(
        "direction-only",
        directionOnly,
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await settleAnsweringRebind(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        directionOnly,
        "direction-only-rebind",
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "recommendation");
      assert.deepEqual(events[0].next, { role: "fixer", phase: "apply" });
      assert.equal(events[0].route, undefined);
      assert.equal(events[0].reason, undefined);
      assert.equal(events[0].command, "ak-role fixer apply");
      assert.equal(harness.prompts(), 2, "unmatched direction-only forces one settlement-bound rebind");
    }

    // 2) next survives broken route + absent reason/command
    {
      const harness = sessionHarness();
      const events: any[] = [];
      const nav = await attendance(setting, harness, events);
      nav.prepare();
      while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
      const brokenRoute = {
        candidates: [{
          route: [{ role: "coder", phase: "apply" }],
          next: { role: "reviewer", phase: null },
        }],
      };
      await harness.tool().execute(
        "broken-route",
        brokenRoute,
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await settleAnsweringRebind(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        brokenRoute,
        "broken-route-rebind",
      );
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
      const noNext = { candidates: [{ reason: "still thinking", route: [{ role: "not-a-role", phase: null }] }] };
      await harness.tool().execute(
        "no-next",
        noNext,
        undefined,
        undefined,
        {} as never,
      );
      harness.release();
      await settleAnsweringRebind(
        nav,
        harness,
        { kind: "accepted", role: "coder", phase: "apply", status: "completed" },
        noNext,
        "no-next-rebind",
      );
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

    // Registry output tools are the contract-owned constants: Navigator targets
    // mirror the packaged registry exactly (absorbed from routes constants test).
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
      ],
    );

    // Command ownership is registry phases on normalized next — no parallel role-name list.
    // Unmatched next is rebound once then passed through as-is (no next.role legality table).
    for (const entry of PACKAGED_ROLE_REGISTRY) {
      for (const phase of entry.phases) {
        const harness = sessionHarness();
        const events: any[] = [];
        const nav = await attendance(setting, harness, events);
        nav.prepare();
        while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
        const batch = { candidates: [{ next: { role: entry.role, phase } }] };
        await harness.tool().execute(
          `cmd-${entry.role}-${String(phase)}`,
          batch,
          undefined,
          undefined,
          {} as never,
        );
        harness.release();
        const settlement = { kind: "accepted" as const, role: "coder", phase: "apply" as const, status: "completed" };
        await settleAnsweringRebind(
          nav,
          harness,
          settlement,
          batch,
          `cmd-rebind-${entry.role}-${String(phase)}`,
        );
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
      await settleAnsweringRebind(
        nav,
        harness,
        { kind: "accepted", role, phase: "apply", status: "completed" },
        batch,
        "empty-advice-rebind",
      );
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
      subject: "work", authority: "Controlling authority names coder apply next.",
      loadSoul: async () => "route judgment",
      loadRoleHelp: async (r) => `help ${r}`,
      createSession: harness.factory,
      modelSettingPath: setting,
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    while (harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    const explicit = {
      candidates: [{ next: { role: "coder", phase: "apply" }, reason: "authority names coder apply next" }],
    };
    await harness.tool().execute(
      "explicit",
      explicit,
      undefined,
      undefined,
      {} as never,
    );
    harness.release();
    await settleAnsweringRebind(
      nav,
      harness,
      { kind: "accepted", role: "fixer", phase: "apply", status: "completed" },
      explicit,
      "explicit-rebind",
    );
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
      sessionManager: { getSessionDir: () => join(process.env.AK_ROLE_RUN_DIR!, "session") },
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
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createRoleRuntimeExtension } = await import("../../src/role-runtime.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");

  const root = await mkdtemp(join(tmpdir(), "navigator-admitted-attendance-"));
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  try {
    const prose = "Admitted instruction prose observed by Navigator attendance.";
    await withActivationHome({ prefix: "ak-nav-admitted-" }, async ({ home }) => {
      const runDir = join(home, ".ak-roles", "books", basename(home), "runs", "judge-admitted");
      await mkdir(join(runDir, "session"), { recursive: true });
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
        loadNavigatorWorkContext: (options) => loadNavigatorWorkContext(pi as never, { ...options, context: toPiContext(options.context) }),
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

      const sessionDir = join(runDir, "session");
      await mkdir(sessionDir, { recursive: true });
      const sessionManager = SessionManager.create(home, sessionDir);
      sessionManager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
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
    sessionManager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() } as never);
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

