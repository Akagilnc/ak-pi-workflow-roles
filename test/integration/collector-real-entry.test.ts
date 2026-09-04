import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorRoleRuntime,
} from "../../src/collector-role.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import type { CollectorClock } from "../../src/collector-evidence.ts";
import { createCollectorLedger } from "../../src/collector-ledger.ts";
import { readCollectorInfrastructureFailure } from "../../src/public-cli/settlement.ts";
import { readLatestSubmissionOutcome, readSealedSubmission } from "../../src/submission-ledger.ts";
import { createFakeGitHubTransport, samplePull, sampleUser } from "../helpers/fake-github-transport.ts";
import { withActivationHome, withInProcessPi } from "../helpers/pi-test-harness.ts";

function clock(): CollectorClock & { elapsed(): number } {
  let elapsed = 0;
  return {
    wallNow: () => new Date(Date.parse("2026-01-01T00:00:00Z") + elapsed),
    monoNow: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
    elapsed: () => elapsed,
  };
}

const soul = "# Collector\nObserve GitHub materials and submit the Collector receipt.";

type CollectorScriptResponse = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[number][number];

async function runRealCollector(options: { request?: boolean; wait?: number } = {}) {
  return withActivationHome({ prefix: "ak-collector-real-entry-" }, async ({ agentDir, home }) => {
    const manifest = resolve(home, "requests.json");
    if (options.request) await writeFile(manifest, JSON.stringify({ requests: [{ id: "Request One", body: "Please review." }] }));
    const transport = createFakeGitHubTransport({ user: sampleUser(), pullRequest: samplePull({ headOid: "head-1" }), reviews: [], issueComments: [], reviewComments: [] });
    const collectorClock = clock();
    const faux = fauxProvider({ api: `collector-real-${options.request ? "request" : "observe"}-${options.wait ?? 0}`, provider: `collector-real-${options.request ? "request" : "observe"}-${options.wait ?? 0}`, tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe-1" }), { stopReason: "toolUse" }),
      ...(options.request ? [(context: any) => {
        const observed = [...context.messages].reverse().find((message: any) => message.role === "toolResult");
        return fauxAssistantMessage(fauxToolCall(COLLECTOR_REQUEST_TOOL, { requestId: "Request One", snapshotId: observed.details.snapshotId }, { id: "request" }), { stopReason: "toolUse" });
      }] : []),
      fauxAssistantMessage(fauxToolCall(COLLECTOR_WAIT_TOOL, { durationMs: options.wait ?? 300_000 }, { id: "wait" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall(COLLECTOR_OUTPUT_TOOL, {}, { id: "output" }), { stopReason: "toolUse" }),
    ] as any);
    let receipt: any;
    await withInProcessPi({
      activationLedgerSession: true, home, cwd: home, agentDir, faux, modelsPath: null,
      extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => transport, createCollectorClock: () => collectorClock, auditSoulCompliance: async () => ({ status: "pass" }) })],
      noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
      flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "1", ...(options.request ? { "ak-collector-request-manifest": manifest } : {}) },
    }, async ({ session, sessionManager }) => {
      await session.prompt("start");
      const entries = [...sessionManager.getEntries()] as any[];
      const output = [...entries].reverse().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL && entry.message.isError === false) as any;
      assert.ok(output, "real role must accept its sole-final output");
      assert.deepEqual(output.message.details, { submissionDisposition: "pending-round-closure" });
      const headerId = sessionManager.getHeader?.()?.id;
      assert.ok(headerId);
      // #604: sealed volume lives under hermetic package home (session path-derive).
      const sealed = await readSealedSubmission(home, headerId, home);
      assert.ok(sealed, "typed turn_end must seal sole candidate");
      receipt = sealed.decisiveFacts;
    });
    return { receipt, transport, elapsed: collectorClock.elapsed() };
  });
}

/** Scripted runner: transport surface fixtures + an explicit model response script; receipts may be absent. */
async function runRealCollectorScript(options: {
  reviews?: any[];
  issueComments?: any[];
  reviewComments?: any[];
  requests?: Array<{ id: string; body: string }>;
  responses: Array<CollectorScriptResponse | ((context: any) => CollectorScriptResponse)>;
}) {
  return withActivationHome({ prefix: "ak-collector-real-script-" }, async ({ agentDir, home }) => {
    const manifest = resolve(home, "requests.json");
    if (options.requests !== undefined) {
      await writeFile(manifest, JSON.stringify({ requests: options.requests }));
    }
    const transport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-1" }),
      reviews: options.reviews ?? [],
      issueComments: options.issueComments ?? [],
      reviewComments: options.reviewComments ?? [],
    });
    const collectorClock = clock();
    const faux = fauxProvider({ api: "collector-real-script", provider: "collector-real-script", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses(options.responses as any);
    const result = await withInProcessPi({
      activationLedgerSession: true, home, cwd: home, agentDir, faux, modelsPath: null,
      extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => transport, createCollectorClock: () => collectorClock, auditSoulCompliance: async () => ({ status: "pass" }) })],
      noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
      flags: {
        "ak-role": "collector",
        "ak-collector-repo": "acme/widgets",
        "ak-collector-pr": "1",
        ...(options.requests === undefined ? {} : { "ak-collector-request-manifest": manifest }),
      },
    }, async ({ session, sessionManager }) => {
      await session.prompt("start");
      const entries = [...sessionManager.getEntries()] as any[];
      const headerId = sessionManager.getHeader?.()?.id;
      const sessionFile = sessionManager.getSessionFile();
      assert.ok(headerId);
      assert.ok(sessionFile);
      // #604: sealed volume lives under hermetic package home (session path-derive).
      const sealed = await readSealedSubmission(home, headerId, home);
      const receipt: any = sealed?.decisiveFacts;
      const latestOutcome = await readLatestSubmissionOutcome(home, headerId, home);
      const infrastructureFailure = await readCollectorInfrastructureFailure(sessionFile);
      return { receipt, latestOutcome, infrastructureFailure, entries, transport, elapsed: collectorClock.elapsed() };
    });
    return result;
  });
}

test("ak-role Collector executes optional request then observes it into the receipt", async () => {
  const result = await runRealCollector({ request: true });
  assert.equal(result.transport.calls.create, 1);
  assert.equal(result.receipt.requestAttempts.length, 1);
  assert.ok(result.receipt.snapshots.length >= 2);
});

test("ak-role Collector observe-only succeeds without a request manifest", async () => {
  const result = await runRealCollector({});
  assert.equal(result.transport.calls.create, 0);
  assert.deepEqual(result.receipt.requestAttempts, []);
});

test("ak-role Collector wait honors the real eligibility cutoff", async () => {
  const result = await runRealCollector({ wait: 300_000 });
  assert.equal(result.elapsed, 300_000);
  assert.ok(result.receipt.snapshots.length >= 2);
});

test("Collector failed reactivation clears a previously successful real role activation", async () => {
  const flags = new Map<string, unknown>([["ak-collector-repo", "acme/widgets"], ["ak-collector-pr", "1"]]);
  const tools = new Map<string, any>(); let active: string[] = [];
  const pi = { registerFlag() {}, getFlag: (name: string) => flags.get(name), getCommands: () => [], getAllTools: () => [...tools.values()], registerTool: (tool: any) => tools.set(tool.name, tool), setActiveTools: (names: string[]) => { active = names; }, getActiveTools: () => active, on() {} };
  const runtime = createCollectorRoleRuntime(pi as any, { loadSoul: async () => soul, createTransport: () => createFakeGitHubTransport({ user: sampleUser(), pullRequest: samplePull(), reviews: [], issueComments: [], reviewComments: [] }), createClock: clock, createLedger: (config, collectorClock) => createCollectorLedger(config, { clock: collectorClock, dossierEntries: [] }) }, { failInfrastructure(error: unknown): never { throw error; } });
  const context = { mode: "print" } as any;
  await runtime.activate(context, { reason: "new" }); flags.delete("ak-collector-repo");
  await assert.rejects(() => runtime.activate(context, { reason: "new" }), /requires --ak-collector-repo/);
  await assert.rejects(() => tools.get(COLLECTOR_OBSERVE_TOOL).execute("call", {}, undefined, undefined), /通进司未激活/);
});

function botIssueComment(overrides: { id: number; userLogin: string; userId: number; body: string }) {
  const htmlUrl = `https://github.com/acme/widgets/pull/1#issuecomment-${overrides.id}`;
  return {
    id: overrides.id,
    userLogin: overrides.userLogin,
    machineIdentity: { userType: "Bot", userId: overrides.userId },
    body: overrides.body,
    createdAt: "2026-01-01T00:01:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    htmlUrl,
    raw: { id: overrides.id },
  };
}

/** Body long enough that its tail sits beyond any bounded observe-context head. */
function hugeTemplateBody(): string {
  const filler = "本 PR 评审额度已用完，请于 1 天后再来。".repeat(30);
  return filler + "HEAD-BOUNDARY-MARKER-BEYOND-BOUNDED-HEAD";
}

const observeOnce = fauxAssistantMessage(fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe-1" }), { stopReason: "toolUse" });

function outputCall(args: unknown, id = "output"): CollectorScriptResponse {
  return fauxAssistantMessage(fauxToolCall(COLLECTOR_OUTPUT_TOOL, args as any, { id }), { stopReason: "toolUse" });
}

function providerText(message: any): string {
  const part = (Array.isArray(message?.content) ? message.content : []).find((item: any) => item?.type === "text" && typeof item.text === "string");
  assert.ok(part, "provider-visible tool results expose a text part");
  return part.text;
}

function providerObserveViews(messages: any[]): any[] {
  return messages
    .filter((message: any) => message?.role === "toolResult" && message.toolName === COLLECTOR_OBSERVE_TOOL && message.isError === false)
    .map((message: any) => JSON.parse(providerText(message)));
}

function providerReadViews(messages: any[]): any[] {
  return messages
    .filter((message: any) => message?.role === "toolResult" && message.toolName === COLLECTOR_READ_TOOL && message.isError === false)
    .map((message: any) => JSON.parse(providerText(message)));
}

function readCall(evidenceId: string, id = "read"): CollectorScriptResponse {
  return fauxAssistantMessage(fauxToolCall(COLLECTOR_READ_TOOL, { evidenceId }, { id }), { stopReason: "toolUse" });
}

function findReceiptFinding(receipt: any): any {
  return receipt.groups.flatMap((group: any) => group.findings)[0];
}

function beyondHeadFindingBody(): string {
  const preamble = `可见摘要：${"这是一段超过观察上下文头部摘录的评审记录前言。".repeat(30)}`;
  return `${preamble}尾部结论：该评论包含一条需要抓取的 finding。`;
}

test("#641 chain① full bodies stay pointer-openable; receipt drops verbatim bodies", async () => {
  const body = beyondHeadFindingBody();
  const result = await runRealCollectorScript({
    issueComments: [botIssueComment({ id: 5001, userLogin: "coderabbitai[bot]", userId: 136622811, body })],
    responses: [
      observeOnce,
      (context: any) => {
        const views = providerObserveViews(context.messages);
        const target = views[views.length - 1].evidence.find((record: any) => record.kind === "issue_comment");
        return readCall(target.evidenceId, "read-1");
      },
      (context: any) => {
        const openedViews = providerReadViews(context.messages);
        const opened = openedViews[openedViews.length - 1];
        return outputCall({ findings: [{ evidenceId: opened.evidenceId, category: "late-conclusion" }] }, "output");
      },
    ],
  });
  assert.ok(result.receipt, "opening by pointer then submitting seals a receipt");

  const observed = providerObserveViews(result.entries.map((entry: any) => entry.message))[0].evidence
    .find((record: any) => record.kind === "issue_comment");
  assert.equal(observed.evidenceId.length > 0, true);
  assert.equal(observed.kind, "issue_comment");
  assert.equal(observed.htmlUrl, "https://github.com/acme/widgets/pull/1#issuecomment-5001");
  assert.notEqual(observed.body, body);
  assert.ok(Buffer.byteLength(observed.body, "utf8") < Buffer.byteLength(body, "utf8"));

  const readEntry = result.entries.find((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_READ_TOOL && entry.message.isError === false);
  assert.ok(readEntry, "the model opens the full material through its pointer");
  const opened = JSON.parse(providerText(readEntry.message));
  assert.equal(opened.evidenceId, observed.evidenceId);
  assert.deepEqual(opened.body, body);

  assert.ok(result.receipt.evidenceRecords.every((record: any) => record.raw === undefined && record.body === undefined));
  assert.ok(result.receipt.groups.every((group: any) => group.materials.every((material: any) => material.body === undefined)));
  assert.equal(result.receipt.groups.flatMap((group: any) => group.findings).length, 1);
  const finding = findReceiptFinding(result.receipt);
  assert.deepEqual(finding.pointer, {
    repository: "acme/widgets",
    prNumber: 1,
    commentId: 5001,
    htmlUrl: "https://github.com/acme/widgets/pull/1#issuecomment-5001",
    authorLogin: "coderabbitai[bot]",
    kind: "issue_comment",
    authoritativeTime: "2026-01-01T00:01:00Z",
  });
  assert.equal(finding.category, "late-conclusion");
  assert.equal(typeof finding.source.evidenceId, "string");
  assert.ok(!("body" in finding));
});

test("#641 chain① read of unknown or non-openable pointers bounces correctable; retry with a stored pointer seals", async () => {
  const body = beyondHeadFindingBody();
  const result = await runRealCollectorScript({
    issueComments: [botIssueComment({ id: 5001, userLogin: "coderabbitai[bot]", userId: 136622811, body })],
    responses: [
      observeOnce,
      readCall("missing0000000000", "read-unknown"),
      (context: any) => {
        const views = providerObserveViews(context.messages);
        const nonOpenable = views[views.length - 1].evidence.find((record: any) => record.kind === "pull_request");
        return readCall(nonOpenable.evidenceId, "read-non-openable");
      },
      (context: any) => {
        const views = providerObserveViews(context.messages);
        const target = views[views.length - 1].evidence.find((record: any) => record.kind === "issue_comment");
        return readCall(target.evidenceId, "read-good");
      },
      (context: any) => {
        const openedViews = providerReadViews(context.messages);
        const opened = openedViews[openedViews.length - 1];
        return outputCall({ findings: [{ evidenceId: opened.evidenceId, category: "late-conclusion" }] }, "output");
      },
    ],
  });
  assert.ok(result.receipt, "retry with a stored pointer seals a receipt");

  const bounced = result.entries.filter((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_READ_TOOL && entry.message.isError === true);
  assert.equal(bounced.length, 2, "unknown and non-openable pointers both reject the read");
  for (const entry of bounced) {
    assert.equal(entry.message.isError, true);
    assert.equal(entry.message.toolName, COLLECTOR_READ_TOOL);
  }
  assert.equal(result.receipt.groups.flatMap((group: any) => group.findings).length, 1);
});

test("#641 chain① zero-finding template stays attendance-only", async () => {
  const result = await runRealCollectorScript({
    issueComments: [
      botIssueComment({ id: 6001, userLogin: "sourcery-ai[bot]", userId: 58596630, body: hugeTemplateBody() }),
    ],
    responses: [observeOnce, outputCall({})],
  });
  assert.ok(result.receipt, "an attendance-only observation seals a lawful receipt");

  assert.equal(result.receipt.groups.flatMap((group: any) => group.findings).length, 0);
  const templateGroup = result.receipt.groups.find((group: any) => group.displayLogin === "sourcery-ai[bot]");
  assert.equal(templateGroup.attendance, true);
  assert.deepEqual(templateGroup.findings, []);
  assert.ok(templateGroup.materials.some((material: any) => material.id === 6001 && material.kind === "issue_comment"));
  assert.ok(result.receipt.groups.every((group: any) => group.materials.every((material: any) => material.body === undefined)));
});

test("#641 chain① unresolvable finding pointers bounce the receipt without tainting a later lawful submission", async () => {
  const result = await runRealCollectorScript({
    issueComments: [botIssueComment({ id: 6101, userLogin: "coderabbitai[bot]", userId: 136622811, body: "有一条 finding。" })],
    responses: [
      observeOnce,
      outputCall({ findings: [{ evidenceId: "missing0000000000" }] }, "output-bad"),
      outputCall({}, "output-good"),
    ],
  });
  assert.ok(result.receipt, "the later lawful submission still seals");

  const bounced = result.entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL && entry.message.isError === true);
  assert.ok(bounced, "unresolvable pointer must reject the submission");
  assert.equal(bounced.message.isError, true);
  assert.equal(bounced.message.toolName, COLLECTOR_OUTPUT_TOOL);
});

test("#641 chain② normal completion misdeclaring infrastructureFailure bounces correctable; retry seals", async () => {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
  const result = await runRealCollectorScript({
    responses: [
      observeOnce,
      outputCall({ infrastructureFailure: { diagnostic: "未发生基础设施失败；本回执为正常完工提交。快照完整，PR OPEN。" } }, "output-misdeclared"),
      outputCall({}, "output-retry"),
    ],
  });
  assert.ok(result.receipt, "the retried lawful submission must seal a receipt");
  assert.equal(result.transport.calls.create, 0);

  const bounced = result.entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL && entry.message.isError === true);
  assert.equal(bounced.length, 1, "exactly the misdeclared attempt is rejected");
  assert.equal(bounced[0].message.isError, true);
  assert.equal(bounced[0].message.toolName, COLLECTOR_OUTPUT_TOOL);
  // The bounced attempt is a rejected terminal submission — the real Collector
  // trunk must record it on the durable ledger as a typed bounce.
  assert.equal(result.latestOutcome?.outcome, "correctable-rejection");
  assert.equal(result.latestOutcome?.code, "typed-bounce");
  } finally {
    process.exitCode = priorExitCode;
  }
});

test("#641 chain② declaration with an unassemblable receipt keeps the shared host failure path", async () => {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
  const result = await runRealCollectorScript({
    responses: [outputCall({ infrastructureFailure: { diagnostic: "宿主机时钟不可信" } }, "output-failed")],
  });
  assert.equal(result.receipt, undefined, "no receipt may seal on a host failure");
  const failed = result.entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL && entry.message.isError === true);
  assert.equal(failed.length, 1);
  } finally {
    process.exitCode = priorExitCode;
  }
});

test("Collector activation restores non-empty session dossier before resumed observe and output", async () => {
  await withActivationHome({ prefix: "ak-collector-session-replay-" }, async ({ agentDir, home }) => {
    const manifest = resolve(home, "requests.json");
    await writeFile(manifest, JSON.stringify({ requests: [{ id: "reviewer", body: "Please review." }] }));
    const sourceClock = clock();
    const sourceTransport = createFakeGitHubTransport({
      user: sampleUser(), pullRequest: samplePull({ headOid: "head-1" }), reviews: [], issueComments: [], reviewComments: [],
      createComment: async () => { throw new Error("interrupted after dispatch"); },
    });
    const sourceFaux = fauxProvider({ api: "collector-session-source", provider: "collector-session-source", tokenSize: { min: 1000, max: 1000 } });
    sourceFaux.setResponses([
      fauxAssistantMessage(fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe-source" }), { stopReason: "toolUse" }),
      (context: any) => {
        const observed = providerObserveViews(context.messages).at(-1);
        assert.ok(observed);
        return fauxAssistantMessage(fauxToolCall(COLLECTOR_REQUEST_TOOL, { requestId: "reviewer", snapshotId: observed.snapshotId }, { id: "request-interrupted" }), { stopReason: "toolUse" });
      },
    ] as any);
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    const sessionManager = await withInProcessPi({
      home, cwd: home, agentDir, faux: sourceFaux, modelsPath: null, activationLedgerSession: true,
      extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => sourceTransport, createCollectorClock: () => sourceClock, auditSoulCompliance: async () => ({ status: "pass" }) })],
      noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
      flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "1", "ak-collector-request-manifest": manifest },
    }, async ({ session, sessionManager: sourceSessionManager }) => {
      await session.prompt("start");
      return sourceSessionManager;
    });
    process.exitCode = priorExitCode;
    const requestEntry = [...sessionManager.getEntries()].find((entry: any) => entry.type === "custom" && entry.customType === "ak-collector-request") as any;
    assert.equal(requestEntry?.data?.attempt?.status, "started");
    const interruptedBody = requestEntry.data.attempt.body as string;
    const resumedTransport = createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull({ headOid: "head-1" }),
      reviews: [], reviewComments: [],
      issueComments: [botIssueComment({ id: 91, userLogin: sampleUser().login, userId: 199175422, body: interruptedBody })],
    });
    const resumedClock = clock();
    const faux = fauxProvider({ api: "collector-session-replay", provider: "collector-session-replay", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe-resumed" }), { stopReason: "toolUse" }),
      outputCall({}, "output-resumed"),
    ] as any);

    await withInProcessPi({
      home, cwd: home, agentDir, faux, modelsPath: null, sessionManager,
      extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => resumedTransport, createCollectorClock: () => resumedClock, auditSoulCompliance: async () => ({ status: "pass" }) })],
      noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
      flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "1", "ak-collector-request-manifest": manifest },
    }, async ({ session }) => {
      await session.prompt("resume");
    });

    const headerId = sessionManager.getHeader?.()?.id;
    assert.ok(headerId);
    const sealed = await readSealedSubmission(home, headerId, home);
    assert.ok(sealed);
    const receipt = sealed.decisiveFacts as any;
    assert.equal(receipt.deadlineTime, "2026-01-01T00:15:00.000Z");
    assert.equal(receipt.requestAttempts[0].status, "recovered");
    assert.ok(receipt.snapshots.length >= 2);
    assert.ok(receipt.evidenceRecords.length > 0);
    assert.equal(resumedTransport.calls.create, 0);
  });
});

test("Collector output candidate blocks a same-turn request before GitHub POST", async () => {
  const result = await runRealCollectorScript({
    requests: [{ id: "reviewer", body: "Please review." }],
    responses: [
      observeOnce,
      (context: any) => {
        const observed = providerObserveViews(context.messages).at(-1);
        assert.ok(observed);
        return fauxAssistantMessage([
          fauxToolCall(COLLECTOR_OUTPUT_TOOL, {}, { id: "output-first" }),
          fauxToolCall(COLLECTOR_REQUEST_TOOL, {
            requestId: "reviewer",
            snapshotId: observed.snapshotId,
          }, { id: "request-after-output" }),
        ], { stopReason: "toolUse" });
      },
    ],
  });

  assert.equal(result.transport.calls.create, 0, "the blocked sibling must not reach GitHub POST");
});

test("#641 P2 read tool real failure writes the typed host fact settlement classifies", async () => {
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    // Pi executes same-turn tools in parallel. Observe claims the operational slot
    // before its first transport await; read then deterministically reaches the real
    // beginOperational overlap failure (not the unknown-pointer correctable path).
    const result = await runRealCollectorScript({
      responses: [
        fauxAssistantMessage([
          fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe-overlap" }),
          fauxToolCall(COLLECTOR_READ_TOOL, { evidenceId: "missing0000000000" }, { id: "read-overlap" }),
        ], { stopReason: "toolUse" }),
      ],
    });
    assert.equal(result.receipt, undefined, "an overlapping operational run must not seal");

    const readEntry = result.entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_READ_TOOL && entry.message.isError === true);
    assert.ok(readEntry, "the overlapping read must fail as infrastructure");
    assert.equal((readEntry.message.details as { kind?: string }).kind, "role_infrastructure_failure", "read failure must carry the typed host fact");
    assert.equal((readEntry.message.details as { reasonCode?: string }).reasonCode, "host_failure");

    const failure = result.infrastructureFailure;
    assert.ok(failure, "settlement must recover the read infrastructure failure from the durable session");
    assert.equal(failure.cause, "activation");
    assert.equal(failure.identity?.name, "CollectorInfrastructureError");
  } finally {
    process.exitCode = priorExitCode;
  }
});
