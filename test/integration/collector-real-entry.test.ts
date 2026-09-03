import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
  createCollectorRoleRuntime,
} from "../../src/collector-role.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import type { CollectorClock } from "../../src/collector-evidence.ts";
import { readSealedSubmission } from "../../src/submission-ledger.ts";
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
  responses: CollectorScriptResponse[];
}) {
  return withActivationHome({ prefix: "ak-collector-real-script-" }, async ({ agentDir, home }) => {
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
    let receipt: any;
    const result = await withInProcessPi({
      activationLedgerSession: true, home, cwd: home, agentDir, faux, modelsPath: null,
      extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => transport, createCollectorClock: () => collectorClock, auditSoulCompliance: async () => ({ status: "pass" }) })],
      noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
      flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "1" },
    }, async ({ session, sessionManager }) => {
      await session.prompt("start");
      const entries = [...sessionManager.getEntries()] as any[];
      const headerId = sessionManager.getHeader?.()?.id;
      assert.ok(headerId);
      // #604: sealed volume lives under hermetic package home (session path-derive).
      const sealed = await readSealedSubmission(home, headerId, home);
      receipt = sealed?.decisiveFacts;
      return { receipt, entries, transport, elapsed: collectorClock.elapsed() };
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
  const runtime = createCollectorRoleRuntime(pi as any, { loadSoul: async () => soul, createTransport: () => createFakeGitHubTransport({ user: sampleUser(), pullRequest: samplePull(), reviews: [], issueComments: [], reviewComments: [] }), createClock: clock }, { failInfrastructure(error: unknown): never { throw error; } });
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

function findObserveEntries(entries: any[]): any[] {
  return entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OBSERVE_TOOL && entry.message.isError === false);
}

function observeText(observeEntries: any[]): string {
  return observeEntries.map((entry) => entry.message.content[0].text).join("\n");
}

function findReceiptFinding(receipt: any): any {
  return receipt.groups.flatMap((group: any) => group.findings)[0];
}

test("#641 chain① observe context carries pointers with bounded body heads; volume keeps full bodies; receipt drops verbatim text", async () => {
  const body = hugeTemplateBody();
  const result = await runRealCollectorScript({
    issueComments: [botIssueComment({ id: 5001, userLogin: "sourcery-ai[bot]", userId: 58596630, body })],
    responses: [observeOnce, outputCall({})],
  });
  assert.ok(result.receipt, "normal completion seals a receipt");

  const context = observeText(findObserveEntries(result.entries));
  assert.ok(!context.includes("HEAD-BOUNDARY-MARKER-BEYOND-BOUNDED-HEAD"), "observe context must not carry full bodies");
  assert.ok(context.includes("issuecomment-5001"), "observe context carries the resolvable url pointer");
  assert.ok(context.includes("evidenceId"), "observe context carries receipt-local evidence pointers");

  // Volume seam keeps the full body for 开卷 verification (details, not model context).
  for (const entry of findObserveEntries(result.entries)) {
    assert.ok(entry.message.details.evidence.some((record: any) => record.body === body));
  }

  const receiptJson = JSON.stringify(result.receipt);
  assert.ok(!receiptJson.includes("评审额度已用完"), "receipt must not transcribe verbatim bodies");
  assert.ok(!receiptJson.includes('"raw"'), "receipt evidence records must not carry raw copies");
  assert.ok(result.receipt.evidenceRecords.every((record: any) => record.raw === undefined && record.body === undefined));
  assert.ok(result.receipt.groups.every((group: any) => group.materials.every((material: any) => material.body === undefined)));
});

test("#641 chain① model-submitted findings carry machine pointers; zero-finding template stays attendance-only", async () => {
  const result = await runRealCollectorScript({
    issueComments: [
      botIssueComment({ id: 6001, userLogin: "sourcery-ai[bot]", userId: 58596630, body: hugeTemplateBody() }),
      botIssueComment({ id: 6002, userLogin: "coderabbitai[bot]", userId: 136622811, body: "发现两处问题：路径拼接未判空；超时时间写死。" }),
    ],
    responses: [
      observeOnce,
      (context: any) => {
        const observe = [...context.messages].reverse().find((message: any) => message.role === "toolResult" && message.toolName === COLLECTOR_OBSERVE_TOOL);
        const target = observe.details.evidence.find((record: any) => record.kind === "issue_comment" && record.authorLogin === "coderabbitai[bot]");
        return fauxAssistantMessage(
          fauxToolCall(COLLECTOR_OUTPUT_TOOL, { findings: [{ evidenceId: target.evidenceId, category: "accuracy" }] }, { id: "output" }),
          { stopReason: "toolUse" },
        );
      },
    ],
  });
  assert.ok(result.receipt, "model-submitted findings seal a lawful receipt");

  assert.equal(result.receipt.groups.flatMap((group: any) => group.findings).length, 1);
  const finding = findReceiptFinding(result.receipt);
  assert.deepEqual(finding.pointer, {
    repository: "acme/widgets",
    prNumber: 1,
    commentId: 6002,
    htmlUrl: "https://github.com/acme/widgets/pull/1#issuecomment-6002",
    authorLogin: "coderabbitai[bot]",
    kind: "issue_comment",
    authoritativeTime: "2026-01-01T00:01:00Z",
  });
  assert.equal(finding.category, "accuracy");
  assert.equal(typeof finding.source.evidenceId, "string");
  assert.ok(!("body" in finding), "findings must not transcribe bodies");

  const templateGroup = result.receipt.groups.find((group: any) => group.displayLogin === "sourcery-ai[bot]");
  assert.equal(templateGroup.attendance, true, "zero-finding template keeps the attendance fact");
  assert.deepEqual(templateGroup.findings, [], "zero-finding template must not become a finding");
  assert.ok(templateGroup.materials.some((material: any) => material.id === 6001 && material.kind === "issue_comment"));
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
  assert.match(String(bounced.message.content[0].text), /不可解析|未存储|无法解析/);
});
