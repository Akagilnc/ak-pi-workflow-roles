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
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { extractNavigatorFact } from "../../src/public-cli/settlement.ts";
import type { PublicSummonResult } from "../../src/public-role-summons.ts";
import { buildNavigatorInfrastructureFailureFact, publicNavigatorSettlement } from "../../src/role-runtime.ts";
import {
  byStatusAdvice,
  proseAdvice,
  sessionHarness,
  attendance,
  settleWithAdvice,
  prepareWithAdvice,
  waitForStandbyOrModelRound,
} from "../helpers/navigator-attendance-kit.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

test("#1160 prepare runs model from parent start; settle picks byStatus without a second round", async () => {
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
    const advice = byStatusAdvice({
      completed: "完成后续送 reviewer",
      unfinished: "未完继续 apply",
    });
    // Playbook diagnostic is observed on the prepare summon, not at settle (#1160).
    harness.setRoutePlaybookReadFailure("ENOENT: missing playbook");
    await prepareWithAdvice(nav, harness, advice, "prepare");
    assert.equal(harness.prompts(), 1, "prepare is the sole model round");
    const preparePrompt = harness.promptTexts()[0];
    assert.equal(typeof preparePrompt, "string");
    const fed = JSON.parse(preparePrompt ?? "") as Record<string, unknown>;
    assert.equal(fed.kind, "prepare");
    assert.equal(fed.role, "coder");
    assert.equal(fed.phase, "apply");
    assert.equal(fed.subjectKey, "/repo/.ak/work/issues/28");
    // #1187: auto prepare is identity-only — parent dispatch must not ride along.
    assert.equal("subject" in fed, false);
    assert.equal("authority" in fed, false);
    assert.equal(typeof fed.invocationId, "string");
    assert.equal("status" in fed, false, "prepare does not know the outcome yet");

    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 1, "settle must not start another model round");
    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "advice");
    assert.equal(events[0].prose, "完成后续送 reviewer");
    assert.equal(events[0].routePlaybookReadFailure, "ENOENT: missing playbook");
    const invocation = harness.entries.find((entry: any) => entry.customType === "ak-navigator-invocation");
    const settlementEntry = harness.entries.find((entry: any) => entry.customType === "ak-navigator-settlement");
    assert.equal((invocation as any).data.invocationId, events[0].invocationId);
    assert.equal((settlementEntry as any).data.invocationId, events[0].invocationId);
    assert.equal((settlementEntry as any).data.status, "completed");
  });
});

test("#1160 missing status key yields no-advice without a settlement model round", async () => {
  await withTempRoot("navigator-missing-status-", async (root) => {
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
    await prepareWithAdvice(nav, harness, byStatusAdvice({ completed: "只备了 completed" }));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "refused" });
    assert.equal(harness.prompts(), 1);
    assert.equal(events[0]?.disposition, "no-advice");
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
    harness.rejectPrepare("root parameters must be an object");
    nav.prepare();
    while (harness.prompts() < 2 || harness.tool() === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    const advice = byStatusAdvice({ completed: "校正后的建议" });
    await harness.tool().execute("corrected-prepare", advice, undefined, undefined, {} as never);
    harness.release();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 2);
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "校正后的建议");
  });
});

test("default delivery ceiling sends two Navigator corrections and then stops", async () => {
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
    harness.rejectPrepare("root rejection one", "root rejection two", "root rejection three");
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 3, "one initial prompt plus two corrections, then stop");
    const deliveryFeed = JSON.parse(harness.promptTexts()[1] ?? "") as {
      terminalToolCalled?: boolean;
      acceptedReceipt?: boolean;
      deliveryTurns?: number;
      rejectedReceipts?: Array<{ reason?: string }>;
    };
    assert.equal(deliveryFeed.terminalToolCalled, true);
    assert.equal(deliveryFeed.acceptedReceipt, false);
    assert.equal(deliveryFeed.deliveryTurns, 1);
    assert.equal(deliveryFeed.rejectedReceipts?.[0]?.reason, "root rejection one");
    assert.equal(events[0]?.disposition, "no-advice");
    // #1178: no parallel parent ak-no-receipt-lifecycle off a dead side-branch pointer.
    assert.equal(harness.entries.some((entry: any) => entry.customType === "ak-no-receipt-lifecycle"), false);
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
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 1);
    // Single materials load: one setModel + one INVOCATION.
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

test("#1160 settle reuses one prepare; different statuses pick different prose; no settle prompt", async () => {
  await withTempRoot("navigator-settlement-pick-", async (root) => {
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
    harness.setRoutePlaybookReadFailure("ENOENT: missing playbook");
    await prepareWithAdvice(
      nav,
      harness,
      byStatusAdvice({
        completed: "完成→reviewer",
        unfinished: "未完→续 apply",
      }),
      "prepare-1",
    );
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "完成→reviewer");
    assert.equal(events[0]?.routePlaybookReadFailure, "ENOENT: missing playbook");
    assert.equal(harness.prompts(), 1);

    // Fresh prepare for the next cycle — clear playbook diagnostic.
    harness.setRoutePlaybookReadFailure("");
    await prepareWithAdvice(
      nav,
      harness,
      byStatusAdvice({ completed: "第二轮 completed" }),
      "prepare-2",
    );
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[1]?.disposition, "advice");
    assert.equal(events[1]?.prose, "第二轮 completed");
    assert.equal(events[1]?.routePlaybookReadFailure, undefined);
    assert.equal(harness.prompts(), 2, "each cycle one prepare round; settle never prompts");
  });
});

test("#959 / #1160 prose advice settles as-is across prepares while changed settings are reread", async () => {
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
    await settleWithAdvice(nav, harness, { kind: "accepted", role: "coder", phase: "apply", status: "completed" }, { prose: "第一步：送 reviewer" }, "prepare-1");
    assert.equal(events[0].disposition, "advice");
    assert.equal(events[0].prose, "第一步：送 reviewer");
    await savePublicCliConfig(
      { seats: { navigator: { provider: "provider", model: "two" } } },
      root,
    );
    await settleWithAdvice(nav, harness, { kind: "accepted", role: "coder", phase: "apply", status: "completed" }, { prose: "第二步：仍送 reviewer" }, "prepare-2");
    assert.equal(events[1].disposition, "advice");
    assert.equal(events[1].prose, "第二步：仍送 reviewer");
    // Prepare is the only model round each cycle.
    assert.equal(harness.prompts(), 2);
    await savePublicCliConfig(
      { seats: { navigator: { provider: "provider", model: "three" } } },
      root,
    );
    await settleWithAdvice(nav, harness, { kind: "accepted", role: "coder", phase: "apply", status: "completed" }, { prose: "第三步：改送 fixer" }, "prepare-3");
    assert.equal(events[2].disposition, "advice");
    assert.equal(events[2].prose, "第三步：改送 fixer");
    // #675 ⑥: bare provider/model has no invented thinking default.
    // setModel once per prepare cycle (no settlement feed reload).
    assert.deepEqual(harness.modelSettings, [
      { model: "provider/one" },
      { model: "provider/two" },
      { model: "provider/three" },
    ]);
    assert.equal(harness.prompts(), 3);
  });
});

test("#959 / #1160 human_decision picks escalate key; infra without status is no-advice", async () => {
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
    await settleWithAdvice(
      nav,
      harness,
      { kind: "human_decision", role: "coder", phase: "apply", status: "escalate" },
      byStatusAdvice({ escalate: "escalate 后仍呈现散文", completed: "其它" }),
      "advice-owner",
    );
    await settleWithAdvice(
      nav,
      harness,
      { kind: "role_infrastructure_failure", role: "coder", phase: "apply" },
      byStatusAdvice({ completed: "infra 无 status 不可取" }),
      "advice-infra",
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(events[0]?.prose, "escalate 后仍呈现散文");
    assert.equal(typeof events[0]?.invocationId, "string");
    assert.ok(String(events[0]?.invocationId).length > 0);
    assert.equal(events[0]?.role, "coder");
    assert.equal(events[0]?.phase, "apply");
    assert.equal(typeof events[0]?.subjectKey, "string");
    // role_infrastructure_failure has no status — byStatus cannot match.
    assert.equal(events[1]?.disposition, "no-advice");
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
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "no-advice");
    // Nested session already settled with its own no_receipt facts; parent does not
    // rewrite a parallel lifecycle (#1178).
    assert.equal(harness.entries.some((entry: any) => entry?.customType === "ak-no-receipt-lifecycle"), false);
  });
});

test("a delivery prompt already sent keeps its count when the nested session reports zero", async () => {
  await withTempRoot("navigator-nested-keeps-sent-", async (root) => {
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
    harness.rejectPrepare("prepare shape rejected");
    harness.settleWithoutReceipt("nested settled without a receipt");
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 2);
    assert.equal(events[0]?.disposition, "no-advice");
    // Delivery count already spent stays in-process; no parent parallel lifecycle (#1178).
    assert.equal(harness.entries.some((entry: any) => entry?.customType === "ak-no-receipt-lifecycle"), false);
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
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });

    const outcome = summoned?.terminal?.roleOutcome;
    assert.equal(outcome?.kind, "failure", JSON.stringify(summoned?.terminal));
    assert.equal(
      outcome && "decisiveFacts" in outcome ? outcome.decisiveFacts.errorCode : undefined,
      "session-id-missing",
    );
    const failedAttempts = outcome && "decisiveFacts" in outcome
      ? outcome.decisiveFacts.failedAttempts as Array<{
          attempt: number;
          diagnostic: string;
          decisiveFacts: { errorCode?: string; secondaryEvidence?: { binary?: string } };
        }> | undefined
      : undefined;
    assert.deepEqual(failedAttempts?.map((entry) => entry.attempt), [0, 1, 2]);
    assert.equal(failedAttempts?.[0]?.decisiveFacts.errorCode, "spawn-failed");
    assert.equal(failedAttempts?.[0]?.decisiveFacts.secondaryEvidence?.binary, missingBin);
    assert.equal(failedAttempts?.[1]?.decisiveFacts.errorCode, "session-id-missing");
    assert.equal(failedAttempts?.[2]?.decisiveFacts.errorCode, "session-id-missing");
    assert.equal(summoned?.terminal?.autoResumeCount, 2);
    assert.ok(failedAttempts?.[0]?.diagnostic);
    const diagnostic =
      outcome && "diagnostic" in outcome && typeof outcome.diagnostic === "string"
        ? outcome.diagnostic
        : "";
    assert.notEqual(diagnostic.trim(), "", "production failure terminal must carry a diagnostic");

    assert.equal(events.length, 1);
    assert.equal(events[0].disposition, "unavailable");
    assert.ok(events[0].unavailableReason);

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
          navigator: events[0],
        },
      },
      {
        type: "custom_message",
        customType: "ak-navigator-attendance",
        message: { details: { disposition: "no-advice" } },
      },
    ] as never);
    assert.equal(terminalNavigator.disposition, "unavailable");
    if (terminalNavigator.disposition === "unavailable") {
      assert.equal(terminalNavigator.reason, events[0].unavailableReason);
    }
  });
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

test("#1160 native public session carries materials and byStatus originals", async () => {
  await withTempRoot("navigator-public-bystatus-", async (root) => {
    await mkdir(join(root, ".ak-roles"), { recursive: true });
    await writeFile(
      join(root, ".ak-roles", "public-cli.json"),
      `${JSON.stringify({ seats: { navigator: { provider: "provider", model: "model" } } }, null, 2)}\n`,
    );
    const setting = join(root, "model.json");
    await writeFile(setting, JSON.stringify({ model: "provider/model" }));
    const parentRun = join(root, ".ak-roles", "books", "probe", "unbound", "runs", "parent@coder");
    await mkdir(join(parentRun, "session"), { recursive: true });
    const events: any[] = [];
    // Opaque status key arrives via JSON (own property), not Object.assign pollution.
    const opaquePayload = JSON.parse('{"__proto__":"opaque-body","completed":{"prose":"original-body","next":"reviewer"}}');
    const nav = createNavigatorAttendance({
      context: { cwd: root, home: root, runDirectory: parentRun } as never,
      role: "coder",
      phase: "apply",
      subjectKey: `${root}/.ak/work`,

      modelSettingPath: setting,
      createSession: createNativeNavigatorSessionFactory({
        hostRunResumable: async () => false,
        summonPublicRole: async (options) => {
          const argvText = typeof options.argv[0] === "string" ? options.argv[0] : "";
          const fed = JSON.parse(argvText) as Record<string, unknown>;
          assert.equal(fed.kind, "prepare");
          // #1187: nested public prepare carries identity, not parent task prose.
          assert.equal("subject" in fed, false);
          assert.equal("authority" in fed, false);
          assert.equal(typeof fed.subjectKey, "string");
          assert.equal(typeof fed.role, "string");
          return {
            exitCode: 0,
            runDirectory: join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navpub@navigator"),
            admitted: { role: "navigator", runDirectory: join(root, ".ak-roles", "books", "probe", "unbound", "runs", "01navpub@navigator") },
            terminal: {
              roleOutcome: {
                kind: "accepted",
                payloads: [
                  { byStatus: opaquePayload },
                  { byStatus: { completed: "body-2" } },
                ],
              },
            },
          } as unknown as PublicSummonResult;
        },
      }),
      onEvent: async (event) => { events.push(event); },
    });
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(events[0]?.disposition, "advice");
    assert.equal(
      events[0]?.prose,
      `${JSON.stringify({ prose: "original-body", next: "reviewer" })}\n\nbody-2`,
    );

    // Fresh prepare cycle reuses the same nested payloads for the opaque status key.
    nav.prepare();
    while (nav.isPreparing()) await new Promise<void>((resolve) => setImmediate(resolve));
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "__proto__" });
    assert.equal(events[1]?.disposition, "advice");
    assert.equal(events[1]?.prose, "opaque-body");
  });
});

test("#1160 cold settle without prior prepare is honest no-advice (no settlement model round)", async () => {
  await withTempRoot("navigator-cold-settle-", async (root) => {
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
    await nav.settle({ kind: "accepted", role: "coder", phase: "apply", status: "completed" });
    assert.equal(harness.prompts(), 0, "settle must not cold-start a model round");
    assert.equal(events[0]?.disposition, "no-advice");
  });
});
