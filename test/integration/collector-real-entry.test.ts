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
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
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

async function runRealCollector(options: { request?: boolean; wait?: number }) {
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
      activationLedgerSession: true, cwd: home, agentDir, faux, modelsPath: null,
      extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => transport, createCollectorClock: () => collectorClock, transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }) })],
      noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin",
      flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "1", ...(options.request ? { "ak-collector-request-manifest": manifest } : {}) },
    }, async ({ session, sessionManager }) => {
      await session.prompt("start");
      const output = [...sessionManager.getEntries()].reverse().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL && entry.message.isError === false) as any;
      assert.ok(output, "real role must accept its sole-final output");
      receipt = output.message.details;
    });
    return { receipt, transport, elapsed: collectorClock.elapsed() };
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

test("ak-role Collector rejects output that is not the sole final call", async () => {
  await withActivationHome({ prefix: "ak-collector-sole-final-" }, async ({ agentDir, home }) => {
    const transport = createFakeGitHubTransport({ user: sampleUser(), pullRequest: samplePull(), reviews: [], issueComments: [], reviewComments: [] });
    const faux = fauxProvider({ api: "collector-sole-final", provider: "collector-sole-final", tokenSize: { min: 1000, max: 1000 } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(COLLECTOR_OBSERVE_TOOL, {}, { id: "observe" }), fauxToolCall(COLLECTOR_OUTPUT_TOOL, {}, { id: "output" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("still no receipt"),
    ]);
    await withInProcessPi({ activationLedgerSession: true, cwd: home, agentDir, faux, modelsPath: null, extensionFactories: [createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "judge", loadCollectorSoul: async () => soul, createCollectorTransport: () => transport, createCollectorClock: clock, transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }) })], noExtensions: true, systemPrompt: "BASE", mode: "print", noTools: "builtin", flags: { "ak-role": "collector", "ak-collector-repo": "acme/widgets", "ak-collector-pr": "1" } }, async ({ session, sessionManager }) => {
      await session.prompt("start");
      const entries = sessionManager.getEntries() as any[];
      const output = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === COLLECTOR_OUTPUT_TOOL);
      // Typed terminal: non-sole-final rejected; no sealed projection.
      assert.equal(output?.message.isError, true, "the original non-sole-final output remains rejected");
      assert.equal(process.exitCode, undefined, "package-owned delivery must not enter Collector's later-input failure path");
      const headerId = sessionManager.getHeader?.()?.id;
      const sealed = headerId === undefined ? undefined : await readSealedSubmission(home, headerId);
      assert.equal(sealed, undefined, "non-sole-final must not produce a sealed submission projection");
    });
  });
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
