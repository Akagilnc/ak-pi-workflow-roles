import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createNativeNavigatorSessionFactory,
  createNavigatorAttendance,
  navigatorProviderFailureFromError,
  parseNavigatorModelSetting,
  navigatorProviderFailureFromPublicTerminal,
} from "../../src/navigator-attendance.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/reviewer-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { extractNavigatorFact } from "../../src/public-cli/settlement.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import { buildAuditEscalationResult } from "../../src/audit-escalation.ts";
import {
  proseAdvice,
  sessionHarness,
  attendance,
  settleWithAdvice,
} from "../helpers/navigator-attendance-kit.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
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
    const nav = await attendance(setting, harness, events, root);
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 0, "standby records attendance and does not call the model");
    assert.equal(
      harness.entries.some((entry: any) => entry.customType === "ak-navigator-invocation"),
      true,
      "standby still books attendance",
    );

    const settlement = { kind: "accepted" as const, role: "coder", phase: "apply" as const, status: "completed" };
    let settled = false;
    const waiting = nav.settle(settlement).then(() => { settled = true; });
    while (harness.tool() === undefined || harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 1);
    const settlementPrompt = harness.promptTexts()[0];
    assert.equal(typeof settlementPrompt, "string");
    const fed = JSON.parse(settlementPrompt ?? "") as Record<string, unknown>;
    assert.equal(fed.kind, settlement.kind);
    assert.equal(fed.status, settlement.status);
    assert.equal(fed.role, settlement.role);
    assert.equal(fed.phase, settlement.phase);
    assert.equal(fed.subjectKey, "/repo/.ak/work/issues/28");
    assert.equal(typeof fed.invocationId, "string");
    assert.equal("authority" in fed, false);
    harness.setRoutePlaybookReadFailure("ENOENT: missing playbook");
    await Promise.resolve();
    assert.equal(settled, false);
    await harness.tool().execute("prepare", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await waiting;
    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "advice");
    assert.equal(events[0].routePlaybookReadFailure, "ENOENT: missing playbook");
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
    const nav = await attendance(setting, harness, events, root);
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.prompts(), 0);
    // Settlement feed rejects once then corrects (budget lives on the output turn).
    harness.rejectPrepare("root parameters must be an object");
    const waiting = nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    while (harness.prompts() < 2 || harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.tool().execute("corrected-prepare", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await waiting;
    assert.equal(harness.prompts(), 2);
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
    const nav = await attendance(setting, harness, events, root);
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    harness.rejectPrepare("root rejection one", "root rejection two");
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 2, "budget exhaustion must not start another prompt");
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
    const nav = await attendance(setting, harness, events, root);
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

test("each model round is only the typed settlement, not a reassembled materials pack", async () => {
  await withTempRoot("navigator-settlement-only-", async (root) => {
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
    const first = { kind: "accepted" as const, role: "coder", phase: "apply" as const, status: "completed", message: "owner words" };
    const settle1 = nav.settle(first);
    while (harness.tool() === undefined || harness.prompts() < 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const firstPrompt = harness.promptTexts()[0];
    assert.equal(typeof firstPrompt, "string");
    const fedFirst = JSON.parse(firstPrompt ?? "") as Record<string, unknown>;
    assert.equal(fedFirst.status, first.status);
    assert.equal(fedFirst.message, first.message);
    assert.equal(fedFirst.subjectKey, "/repo/.ak/work/issues/28");
    harness.setRoutePlaybookReadFailure("ENOENT: missing playbook");
    await harness.tool().execute("prepare-1", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await settle1;
    assert.equal(events[0]?.routePlaybookReadFailure, "ENOENT: missing playbook");
    harness.setRoutePlaybookReadFailure("");
    const second = { kind: "accepted" as const, role: "coder", phase: "apply" as const, status: "completed", message: "second typed fact" };
    const settle2 = nav.settle(second);
    while (harness.prompts() < 2 || harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    const secondPrompt = harness.promptTexts()[1];
    const priorPrompt = harness.promptTexts()[0];
    assert.equal(typeof secondPrompt, "string");
    assert.equal(typeof priorPrompt, "string");
    const fedSecond = JSON.parse(secondPrompt ?? "") as Record<string, unknown>;
    assert.equal(fedSecond.message, second.message);
    assert.equal(fedSecond.subjectKey, "/repo/.ak/work/issues/28");
    assert.equal(JSON.parse(priorPrompt ?? "").invocationId, fedSecond.invocationId);
    await harness.tool().execute("prepare-2", proseAdvice(), undefined, undefined, {} as never);
    harness.release();
    await settle2;
    assert.equal(events[1]?.routePlaybookReadFailure, undefined);
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
    const nav = await attendance(setting, harness, events, root);
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
    // Standby does not prompt; each settlement is one model round.
    assert.equal(harness.prompts(), 2);
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
    assert.equal(harness.prompts(), 3);
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
    const nav = await attendance(setting, harness, events, root);
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
    assert.equal(harness.prompts(), 2);
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
    const nav = await attendance(setting, harness, events, root);
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

test("#959 missing host binary diagnostic reaches terminal.navigator.reason", async () => {
  // 怎么验#2: missing binary → headless knownFailure → public failure terminal
  // (summonPublicRole / instruction-seat) → attendance unavailable → extractNavigatorFact.
  // Thin summon wrapper only injects host/credentials/adapters — never hand-builds roleOutcome.
  await withTempRoot("navigator-unavailable-chain-", async (root) => {
    seedGitRepository(root);
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({
        seats: {
          navigator: {
            provider: "openai-codex",
            model: "gpt-test",
            host: "codex",
          },
        },
      }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "openai-codex/gpt-test" }));
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });

    const description = lookupHeadlessHostDescription("codex");
    assert.ok(description);
    const missingBin = join(root, "no-such-codex-binary");
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: "codex",
      binary: missingBin,
      sessionIdentity: {
        async load() { return undefined; },
        async bind() {},
        resolveSessionFile: () => join(root, "session", "session.jsonl"),
      },
      prepare: async () => ({
        mcpServers: [],
        systemPrompt: { body: "system", materials: [] },
        prompt: "probe",
        jsonSchema: { type: "object" },
        terminatingToolName: NAVIGATOR_OUTPUT_TOOL_NAME,
        async ingestStructuredOutput() {},
        async closeRound() { return { accepted: true as const }; },
      }),
    });

    let summoned: PublicSummonResult | undefined;
    const events: any[] = [];
    const nav = createNavigatorAttendance({
      context: { cwd: root, home: root, runDirectory: parentRun } as never,
      role: "coder",
      phase: "apply",
      subjectKey: "/repo/.ak/work/issues/28",
      subject: "Fix issue 28",
      authority: "owner decision",
      modelSettingPath: setting,
      createSession: createNativeNavigatorSessionFactory({
        summonPublicRole: async (options) => {
          const { summonPublicRole } = await import("../../src/public-role-summons.ts");
          summoned = await summonPublicRole({
            ...options,
            packageRoot,
            host: "codex",
            model: { provider: "openai-codex", model: "gpt-test", thinking: "low" },
            credentials: { "openai-codex": true, xai: true },
            hostAdapters: [
              { name: "codex", create: () => ({ ok: true as const, host }) },
            ],
            createRunId: () => "01navmiss",
          });
          return summoned;
        },
      }),
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });

    const outcome = summoned?.terminal?.roleOutcome;
    assert.equal(outcome?.kind, "failure", JSON.stringify(summoned?.terminal));
    assert.equal(
      outcome && "decisiveFacts" in outcome ? outcome.decisiveFacts.errorCode : undefined,
      "spawn-failed",
    );
    assert.equal(
      outcome && "decisiveFacts" in outcome
        ? (outcome.decisiveFacts.secondaryEvidence as { binary?: string } | undefined)?.binary
        : undefined,
      missingBin,
    );
    const diagnostic =
      outcome && "diagnostic" in outcome && typeof outcome.diagnostic === "string"
        ? outcome.diagnostic
        : "";
    assert.notEqual(diagnostic.trim(), "", "production failure terminal must carry a diagnostic");

    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "unavailable");
    assert.equal(events[0].unavailableReason, diagnostic);

    const invocationId = events[0].invocationId as string;
    const terminalNavigator = extractNavigatorFact([
      {
        type: "custom",
        customType: "ak-navigator-invocation",
        data: {
          invocationId,
          role: "coder",
          phase: "apply",
          subjectKey: "/repo/.ak/work/issues/28",
        },
      },
      {
        type: "custom",
        customType: "ak-role-submission-closure",
        data: {
          toolName: FIXER_OUTPUT_TOOL_NAME,
          isError: false,
          details: { status: "completed" },
        },
      },
      {
        type: "custom_message",
        customType: "ak-navigator-attendance",
        message: { details: events[0] },
      },
    ] as never);
    assert.equal(terminalNavigator.disposition, "unavailable");
    if (terminalNavigator.disposition === "unavailable") {
      assert.equal(terminalNavigator.reason, diagnostic);
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
  assert.deepEqual(publicNavigatorSettlement("judge", null, { toolName: "ak_submission_output", isError: false, details: { status: "escalate", report: "any wording" } }), { kind: "human_decision", role: "judge", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("countersign", null, { toolName: "ak_submission_output", isError: false, details: { status: "escalate" } }), { kind: "human_decision", role: "countersign", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("secretariat", null, { toolName: "ak_secretariat_output", isError: false, details: { secretariatStatus: "escalate" } }), { kind: "human_decision", role: "secretariat", phase: null, status: "escalate" });
  assert.deepEqual(publicNavigatorSettlement("secretariat", null, { toolName: "ak_secretariat_output", isError: false, details: { secretariatStatus: "converged" } }), { kind: "accepted", role: "secretariat", phase: null, status: "converged" });
  assert.notEqual(publicNavigatorSettlement("fixer", "apply", { toolName: "ak_fixer_output", isError: false, details: { kind: "audit_escalation", conflicts: ["authority"], auditDecisionGate: { question: "Which?", options: ["owner"] } } })?.kind, "human_decision");
});
