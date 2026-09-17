import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNavigatorAttendance,
  navigatorProviderFailureFromError,
  parseNavigatorModelSetting,
  navigatorProviderFailureFromPublicTerminal,
} from "../../src/navigator-attendance.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import {
  context,
  proseAdvice,
  sessionHarness,
  attendance,
  settleWithAdvice,
} from "../helpers/navigator-attendance-kit.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("Navigator early prepare from parent start; settle feeds result for output", async () => {
  await withTempRoot("navigator-attendance-", async (root) => {
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
    // Early host round starts immediately (ready and wait) — no final settlement yet.
    while (harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 1);
    assert.deepEqual(harness.retainedContext().currentRole, { role: "coder", phase: "apply" });
    assert.equal(harness.retainedContext().subject, "Fix issue 28");
    assert.equal(harness.retainedContext().authority, "owner decision");
    assert.equal(harness.retainedContext().subjectKey, "/repo/.ak/work/issues/28");
    assert.equal(harness.retainedContext().currentSettlement, undefined);
    harness.release();
    // preparation promise may still be referenced until settle drains it — yield for early turn end.
    for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    const settlement = { kind: "accepted" as const, role: "coder", phase: "apply" as const, status: "completed" };
    let settled = false;
    const waiting = nav.settle(settlement).then(() => { settled = true; });
    while (harness.tool() === undefined || harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 2);
    assert.deepEqual(harness.retainedContext().currentSettlement, settlement);
    assert.ok(harness.retainedContext().publicSettlementHistory.some((s: any) => s.kind === "accepted" && s.role === "coder"));
    await Promise.resolve();
    assert.equal(settled, false);
    await harness.tool().execute("prepare", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await waiting;
    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "advice");
    assert.equal(typeof events[0].prose, "string");
    assert.ok(events[0].prose.trim().length > 0);
    const invocation = harness.entries.find((entry: any) => entry.customType === "ak-navigator-invocation");
    const settlementEntry = harness.entries.find((entry: any) => entry.customType === "ak-navigator-settlement");
    assert.equal((invocation as any).data.invocationId, events[0].invocationId);
    assert.equal((settlementEntry as any).data.invocationId, events[0].invocationId);
  });
});

test("rejected Navigator prepare consumes budget and correction succeeds in the same session", async () => {
  await withTempRoot("navigator-rejected-prepare-", async (root) => {
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
    // Early ready-wait has no rejection budget.
    while (harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    harness.release();
    for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    // Settlement feed rejects once then corrects (budget lives on the output turn).
    harness.rejectPrepare("root parameters must be an object");
    const waiting = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    while (harness.prompts() < 3 || harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("corrected-prepare", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await waiting;
    assert.equal(harness.prompts(), 3);
    assert.equal(events[0]?.disposition, "advice");
    assert.ok(typeof events[0]?.prose === "string" && events[0].prose.trim().length > 0);
  });
});

test("two rejected Navigator prepares settle typed no-advice with exact reasons and no third prompt", async () => {
  await withTempRoot("navigator-rejected-exhaustion-", async (root) => {
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
    harness.release();
    for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    harness.rejectPrepare("root rejection one", "root rejection two");
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    // early(1) + two rejected settle feeds(2) — no fourth prompt
    assert.equal(harness.prompts(), 3, "budget exhaustion must not start a fourth prompt");
    assert.equal(events[0]?.disposition, "no-advice");
    const lifecycle = harness.entries.find((entry: any) => entry.customType === "ak-no-receipt-lifecycle") as any;
    assert.deepEqual(lifecycle?.data.rejectedReceipts, [
      { reason: "root rejection one", diagnosticAvailable: true },
      { reason: "root rejection two", diagnosticAvailable: true },
    ]);
    assert.equal(lifecycle?.data.terminalToolCalled, true);
  });
});

test("Navigator transport failure remains unavailable and does not enter rejected-prepare budget", async () => {
  await withTempRoot("navigator-prepare-transport-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const harness = sessionHarness();
    harness.failTransport("socket reset");
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    // Cold settle (no early prepare): one feed prompt hits transport failure.
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 1);
    // Single materials load: one setModel + one INVOCATION (not a second prepare reload).
    assert.equal(harness.modelSettings.length, 1);
    assert.equal(
      harness.entries.filter((entry: any) => entry.customType === "ak-navigator-invocation").length,
      1,
    );
    assert.equal(events[0]?.disposition, "unavailable");
    assert.equal(events[0]?.unavailableSource, "transport");
    assert.equal(harness.entries.some((entry: any) => entry.customType === "ak-no-receipt-lifecycle"), false);
  });
});

test("live help changes the next hint without a static template or fabricated task arguments", async () => {
  await withTempRoot("navigator-help-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    let help = "Usage: pi --ak-role coder --ak-coder-phase <phase>";
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, async (role) => `${help} (${role})`, root);
    nav.prepare();
    while (harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.retainedContext().liveRoleHelp.find((entry: any) => entry.role === "coder").help.includes("ak-coder-phase"), true);
    harness.release();
    for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const settle1 = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    while (harness.tool() === undefined || harness.prompts() < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare-1", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await settle1;
    help = "Usage: pi --ak-role coder --ak-coder-task <file>";
    nav.prepare();
    while (harness.prompts() < 3) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.retainedContext().liveRoleHelp.find((entry: any) => entry.role === "coder").help.includes("ak-coder-task"), true);
    assert.equal(harness.retainedContext().liveRoleHelp.some((entry: any) => entry.help.includes("/repo/task.md")), false);
    harness.release();
    for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const settle2 = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    while (harness.prompts() < 4 || harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("prepare-2", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await settle2;
  });
});

test("#959 prose advice settles as-is across prepares while changed settings are reread", async () => {
  await withTempRoot("navigator-prose-settings-", async (root) => {
    // Existing withTempRoot holds the caller navigator seat fixture; pass as explicit context.home.
    const { savePublicCliConfig } = await import("../../src/public-cli/config.ts");
    await savePublicCliConfig(
      { seats: { navigator: { provider: "provider", model: "one" } } },
      root,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "ignored/legacy" }));
    const harness = sessionHarness();
    const events: any[] = [];
    const nav = await attendance(setting, harness, events, undefined, root);
    nav.prepare();
    await settleWithAdvice(nav, harness, { kind: "accepted", role: "coder", phase: "apply", status: "completed" }, { prose: "第一步：送 reviewer" }, "prepare-1");
    assert.equal(events[0].disposition, "advice");
    assert.equal(events[0].prose, "第一步：送 reviewer");
    await savePublicCliConfig(
      { seats: { navigator: { provider: "provider", model: "two" } } },
      root,
    );
    nav.prepare();
    await settleWithAdvice(nav, harness, { kind: "accepted", role: "coder", phase: "apply", status: "completed" }, { prose: "第二步：仍送 reviewer" }, "prepare-2");
    assert.equal(events[1].disposition, "advice");
    assert.equal(events[1].prose, "第二步：仍送 reviewer");
    // Each cycle: early ready-wait + settlement feed output.
    assert.equal(harness.prompts(), 4);
    await savePublicCliConfig(
      { seats: { navigator: { provider: "provider", model: "three" } } },
      root,
    );
    nav.prepare();
    await settleWithAdvice(nav, harness, { kind: "accepted", role: "coder", phase: "apply", status: "completed" }, { prose: "第三步：改送 fixer" }, "prepare-3");
    assert.equal(events[2].disposition, "advice");
    assert.equal(events[2].prose, "第三步：改送 fixer");
    // #675 ⑥: bare provider/model has no invented thinking default.
    // setModel on early + feed each cycle.
    assert.deepEqual(harness.modelSettings, [
      { model: "provider/one" },
      { model: "provider/one" },
      { model: "provider/two" },
      { model: "provider/two" },
      { model: "provider/three" },
      { model: "provider/three" },
    ]);
    assert.equal(harness.prompts(), 6);
  });
});

test("#959 human_decision and role-infrastructure still present prepared prose", async () => {
  await withTempRoot("navigator-human-prose-", async (root) => {
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
    await settleWithAdvice(nav, harness, { kind: "human_decision", role: "coder", phase: "apply", status: "escalate" }, proseAdvice("escalate 后仍呈现散文"), "advice-owner");
    nav.prepare();
    await settleWithAdvice(nav, harness, { kind: "role_infrastructure_failure", role: "coder", phase: "apply" }, proseAdvice("infra 后仍呈现散文"), "advice-infra");
    assert.equal(events.length, 2);
    // #959: parent escalate/infra must not wipe already-prepared navigator prose.
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "escalate 后仍呈现散文");
    assert.equal(typeof events[0]?.invocationId, "string");
    assert.ok(String(events[0]?.invocationId).length > 0);
    assert.equal(events[0]?.role, "coder");
    assert.equal(events[0]?.phase, "apply");
    assert.equal(typeof events[0]?.subjectKey, "string");
    assert.equal(events[1]?.disposition, "advice");
    assert.equal(events[1]?.prose, "infra 后仍呈现散文");
    // One attendance instance keeps one exact principal across settles.
    assert.equal(events[1]?.invocationId, events[0]?.invocationId);
    assert.equal(harness.prompts(), 4);
  });
});

test("a session that settled without a receipt is not re-summoned for delivery", async () => {
  await withTempRoot("navigator-nested-no-receipt-", async (root) => {
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
    harness.settleWithoutReceipt("no typed candidate batch");
    // Bound feed only (no early): nested session settles without receipt once.
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    // Each prompt is an independent public summon: a delivery request after the
    // session settled opens new sessions instead of pressing the one that owes
    // the receipt.
    assert.equal(harness.prompts(), 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "no-advice");
    const lifecycle = harness.entries.filter((entry: any) => entry?.customType === "ak-no-receipt-lifecycle");
    assert.equal(lifecycle.length, 1);
    const facts = (lifecycle[0] as any).data;
    assert.equal(facts.terminalToolCalled, true);
    assert.deepEqual(facts.rejectedReceipts, [
      { reason: "no typed candidate batch", diagnosticAvailable: true },
    ]);
    assert.equal(facts.runPointer, "/fixture/navigator-record");
  });
});

test("Navigator session creation failures become unavailable without rejecting settlement", async () => {
  await withTempRoot("navigator-unavailable-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    for (const diagnostic of ["provider auth down", "session open failed with different wording"]) {
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
        createSession: async () => { throw new Error(diagnostic); },
        onEvent: async (event) => { events.push(event); } });
      nav.prepare();
      await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
      assert.equal(events.length, 1);
      assert.equal(events[0].disposition, "unavailable");
      assert.equal(events[0].unavailableSource, "session");
      assert.equal(events[0].unavailableCause, "session");
      assert.notEqual(events[0].unavailableReason, undefined);
    }
  });
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
      decisionGate: { question: `${seat.role} question`, options: ["owner", "audit"] } }, { [seat.role]: "role output" });
    assert.deepEqual(
      publicNavigatorSettlement(seat.role, seat.phase, {
        toolName: seat.toolName,
        isError: false,
        details: projected }),
      { kind: "human_decision", role: seat.role, phase: seat.phase, status: "audit_escalation" },
      seat.role,
    );
    // The same visible shape, including every audit-owned field/value, is
    // still only role-authored data after the object identity is copied.
    assert.notEqual(
      publicNavigatorSettlement(seat.role, seat.phase, {
        toolName: seat.toolName,
        isError: false,
        details: { ...projected } })?.kind,
      "human_decision",
      `${seat.role}: copied role-shaped details must not escalate Navigator`,
    );
    const auditConflicts = Array.isArray((projected.audit as { conflicts?: unknown } | undefined)?.conflicts)
      ? [...((projected.audit as { conflicts: readonly unknown[] }).conflicts)]
      : Array.isArray(projected.conflicts)
        ? [...(projected.conflicts as readonly unknown[])]
        : [];
    for (const forged of [
      { ...projected, status: "pass" },
      { ...projected, kind: "audit_escalation", auditDecisionGate: undefined },
      { ...projected, conflicts: ["wrong"] },
      { ...projected, conflicts: [...auditConflicts, "duplicate"] },
      { ...projected, conflicts: [...auditConflicts].reverse() },
    ]) {
      assert.notEqual(
        publicNavigatorSettlement(seat.role, seat.phase, {
          toolName: seat.toolName,
          isError: false,
          details: { ...forged } })?.kind,
        "human_decision",
        `${seat.role}: forged audit evidence must not escalate Navigator`,
      );
    }
  }
});

test("navigator open failures classify typed reason/status/code, not Error.message prose", () => {
  assert.equal(navigatorProviderFailureFromError(new Error("authentication failed")), undefined);
  assert.equal(navigatorProviderFailureFromError(new Error("provider not found: missing")), undefined);
  assert.deepEqual(
    navigatorProviderFailureFromError(Object.assign(new Error("opaque"), { reason: "auth" })),
    { source: "auth", cause: "auth" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromError(Object.assign(new Error("opaque"), { reason: "model" })),
    { source: "model", cause: "model" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromError(Object.assign(new Error("opaque"), { statusCode: 401 })),
    { source: "auth", cause: "auth" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromError({ cause: Object.assign(new Error("nested"), { reason: "quota" }) }),
    { source: "quota", cause: "quota" },
  );
});

test("untyped public navigator failure keeps unknown cause instead of relabeling session", () => {
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      diagnostic: "opaque provider wording",
      decisiveFacts: { diagnostic: "opaque provider wording" },
    }),
    { source: "unknown", cause: "unknown" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      cause: "session",
      diagnostic: "session unreadable",
      decisiveFacts: {},
    }),
    { source: "session", cause: "session" },
  );
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      cause: "provider",
      diagnostic: "provider failure",
      decisiveFacts: { httpStatus: 401 },
    }),
    { source: "auth", cause: "auth" },
  );
  // cause=provider alone does not confirm a transport subclass — cause stays unknown.
  assert.deepEqual(
    navigatorProviderFailureFromPublicTerminal({
      cause: "provider",
      diagnostic: "provider failure",
      decisiveFacts: {},
    }),
    { source: "transport", cause: "unknown" },
  );
});

test("model settings are exact and typed settlement projection ignores prose and correctable errors", () => {
  assert.deepEqual(parseNavigatorModelSetting("openai-codex/gpt-5.6-luna:max"), { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" });
  assert.deepEqual(parseNavigatorModelSetting("provider/model:medium"), { provider: "provider", model: "model", thinkingLevel: "medium" });
  assert.deepEqual(parseNavigatorModelSetting("provider/model:xhigh"), { provider: "provider", model: "model", thinkingLevel: "xhigh" });
  // Bare provider/model omits thinkingLevel — no invented default.
  assert.deepEqual(parseNavigatorModelSetting("provider/model"), { provider: "provider", model: "model" });
  // Suffix is opaque pass-through; no whitelist reject (#683 / #675 ⑥).
  assert.deepEqual(parseNavigatorModelSetting("provider/model:backup"), { provider: "provider", model: "model", thinkingLevel: "backup" });
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { message: "correctable schema wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: buildNavigatorInfrastructureFailureFact() }), { kind: "role_infrastructure_failure", role: "coder", phase: "apply" });
  assert.equal(publicNavigatorSettlement("coder", "apply", { toolName: "ak_coder_output", isError: true, details: { terminal: "infrastructure_failure", message: "network wording" } }), undefined);
  assert.deepEqual(publicNavigatorSettlement("judge", null, { toolName: "ak_judge_output", isError: false, details: { judgeStatus: "escalate", report: "any wording" } }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("countersign", null, { toolName: "ak_countersign_output", isError: false, details: { countersignStatus: "escalate" } }), { kind: "human_decision", role: "countersign", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("secretariat", null, { toolName: "ak_secretariat_output", isError: false, details: { secretariatStatus: "escalate" } }), { kind: "human_decision", role: "secretariat", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("secretariat", null, { toolName: "ak_secretariat_output", isError: false, details: { secretariatStatus: "converged" } }), { kind: "accepted", role: "secretariat", phase: null, status: "converged" });
  assert.notEqual(publicNavigatorSettlement("fixer", "apply", { toolName: "ak_fixer_output", isError: false, details: { kind: "audit_escalation", conflicts: ["authority"], auditDecisionGate: { question: "Which?", options: ["owner"] } } })?.kind, "human_decision");
});
