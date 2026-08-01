import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { sha256Hex } from "../src/sha256.ts";
import { createMergerRoleRuntime } from "../src/merger-role.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../src/merger-contracts.ts";
import { withHermeticHome, withInProcessPi } from "./helpers/pi-test-harness.ts";

const oid = (c: string) => c.repeat(40);
const mat = (s: string) => ({ bytesBase64: Buffer.from(s).toString("base64"), sha256: sha256Hex(s) });
const input = { version: 1 as const, attemptId: "attempt", targetObjectId: oid("a"), sourceObjectId: oid("b"), materials: { task: mat("task"), authority: mat("authority"), targetIntent: mat("target intent"), sourceIntent: mat("source intent") }, expectedConflictPaths: ["same.txt"], resolutionScope: ["same.txt"], authorizedChecks: [{ name: "test", argv: ["npm", "test"] }] };
function harness(flag: unknown = "/input.json") { const flags = new Map<string, unknown>([["ak-merger-input", flag]]); const tools = new Map<string, any>(); const handlers = new Map<string, any>(); let active: string[] = []; const host = ["read", "grep", "find", "ls", "bash", "write", "edit", "Agent", "web"]; const pi = { registerFlag(name: string) { if (!flags.has(name)) flags.set(name, undefined); }, getFlag(name: string) { return flags.get(name); }, registerTool(tool: any) { tools.set(tool.name, tool); }, getAllTools() { return [...host, ...tools.keys()].map(name => ({ name })); }, setActiveTools(names: string[]) { active = names; }, getActiveTools() { return active; }, on(name: string, fn: any) { handlers.set(name, fn); } }; return { pi, tools, handlers, active: () => active }; }
function context(id: string, args: Record<string, unknown>, calls = 1, abort = () => {}): ExtensionContext { const sessionManager = SessionManager.inMemory(); const content = Array.from({ length: calls }, (_, i) => ({ type: "toolCall" as const, id: i ? `sibling-${i}` : id, name: i ? "bash" : MERGER_OUTPUT_TOOL_NAME, arguments: i ? {} : args })); const message: AssistantMessage = { role: "assistant", content, api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 }; sessionManager.appendMessage(message); return { sessionManager, abort, mode: "json" } as unknown as ExtensionContext; }
function setup(overrides: any = {}) { const h = harness(); let completedCalls = 0; const runtime = createMergerRoleRuntime(h.pi as unknown as ExtensionAPI, { loadSoul: async () => "MERGER LAW", loadInput: async () => input, gitState: { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async (id: string, tree: string) => { completedCalls++; assert.equal(tree, oid("d")); return { mergeCommitId: id, parentObjectIds: [oid("a"), oid("b")], unmergedPaths: [], worktreeClean: true, resolutionChangedPaths: ["same.txt"] }; } }, ...overrides }, { failInfrastructure(error: unknown, ctx: ExtensionContext): never { ctx.abort(); throw error; } }); return { ...h, runtime, completedCalls: () => completedCalls }; }

test("Merger activation preflights frozen identity and narrows to the exact resolution tools", async () => {
  const h = setup(); await h.runtime.activate();
  assert.deepEqual(h.active(), ["read", "grep", "find", "ls", "bash", "write", "edit", MERGER_OUTPUT_TOOL_NAME]);
  const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "BASE" });
  assert.match(prompt.systemPrompt, /MERGER LAW/); assert.match(prompt.systemPrompt, /target intent/); assert.match(prompt.systemPrompt, /npm/); assert.doesNotMatch(prompt.systemPrompt, /\/input\.json/);
});

test("Merger activation rejects non-conflicts, incomplete conflict sets, and parent drift", async () => {
  for (const state of [
    { targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: [], automaticMergeTreeId: oid("d") },
    { targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["other.txt"], automaticMergeTreeId: oid("d") },
    { targetObjectId: oid("c"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") },
    { targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: "" },
  ]) await assert.rejects(setup({ gitState: { activeMerge: async () => state, completedMerge: async () => { throw new Error("unused"); } } }).runtime.activate(), /Merger activation/);
});

test("Merger accepts one honest escalation without Git success verification", async () => {
  const h = setup(); await h.runtime.activate(); const args = { status: "escalate", attemptId: "attempt", diagnosis: "new product decision", report: "both authorized intents cannot coexist" };
  const result = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("out", args, undefined, undefined, context("out", args));
  assert.equal(result.terminate, true); assert.deepEqual(result.details, args); assert.equal(h.completedCalls(), 0);
  await assert.rejects(h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("again", args, undefined, undefined, context("again", args)), /already accepted/);
});

test("Merger terminal contract and singleton failures abort without accepting a receipt", async () => {
  const valid = { status: "escalate", attemptId: "attempt", diagnosis: "new product decision", report: "both authorized intents cannot coexist" };
  for (const { args, calls, message } of [
    { args: { status: "escalate", attemptId: "attempt", report: "missing diagnosis" }, calls: 1, message: /exact completed\|escalate contract/ },
    { args: { ...valid, attemptId: "wrong" }, calls: 1, message: /attempt mismatch/ },
    { args: valid, calls: 2, message: /sole final/ },
  ]) {
    const h = setup(); await h.runtime.activate(); let aborted = 0;
    await assert.rejects(h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("out", args, undefined, undefined, context("out", args, calls, () => aborted++)), message);
    assert.equal(aborted, 1);
    const accepted = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("accepted", valid, undefined, undefined, context("accepted", valid));
    assert.equal(accepted.terminate, true);
  }
});

test("Pi transports malformed Merger candidates to the fatal validator while valid leaves still terminate", async () => {
  await withHermeticHome({ prefix: "ak-merger-transport-" }, async ({ home, agentDir }) => {
    for (const candidate of [
      { status: "escalate", attemptId: "attempt", report: "missing diagnosis" },
      { status: "escalate", attemptId: "attempt", diagnosis: "decision", report: "blocked", unknown: true },
      { status: "escalate", attemptId: "attempt", diagnosis: "decision", report: "blocked" },
    ]) {
      const faux = fauxProvider({ api: `merger-${Object.keys(candidate).length}`, provider: `merger-${Object.keys(candidate).length}` });
      faux.setResponses([fauxAssistantMessage(fauxToolCall(MERGER_OUTPUT_TOOL_NAME, candidate, { id: "out" }), { stopReason: "toolUse" })]);
      let aborts = 0; let exitCode = 0;
      await withInProcessPi({ cwd: home, agentDir, faux, modelsPath: null, noExtensions: true, systemPrompt: "MERGER", mode: "print", flags: { "ak-merger-input": "/input.json" }, extensionFactories: [(pi) => {
        const runtime = createMergerRoleRuntime(pi, { loadSoul: async () => "MERGER LAW", loadInput: async () => input, gitState: { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async () => { throw new Error("unused"); } } }, { failInfrastructure(error, ctx): never { aborts++; exitCode = 1; ctx.abort(); throw error; } });
        pi.on("session_start", () => runtime.activate());
      }] }, async ({ session, sessionManager }) => {
        if (Object.hasOwn(candidate, "unknown") || !Object.hasOwn(candidate, "diagnosis")) {
          await session.prompt("Settle.");
          assert.equal(aborts, 1); assert.equal(exitCode, 1);
          const results = sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult") as any[];
          assert.equal(results.length, 1); assert.equal(results[0]!.message.role, "toolResult");
          if (results[0]!.message.role === "toolResult") { assert.equal(results[0]!.message.isError, true); assert.deepEqual(results[0]!.message.details, {}); assert.match(results[0]!.message.content[0]!.type === "text" ? results[0]!.message.content[0]!.text : "", /exact completed\|escalate contract/); }
        } else {
          await session.prompt("Settle.");
          const results = sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult") as any[];
          assert.equal(aborts, 0); assert.equal(exitCode, 0); assert.equal(results.length, 1);
          assert.equal(results[0]!.message.role, "toolResult");
          if (results[0]!.message.role === "toolResult") { assert.equal(results[0]!.message.isError, false); assert.deepEqual(results[0]!.message.details, candidate); }
        }
        assert.equal(faux.getPendingResponseCount(), 0);
      });
    }
  });
});

test("Merger completion requires exact parents, clean worktree, and no unmerged paths", async () => {
  const args = { status: "completed", attemptId: "attempt", report: "resolved", mergeCommitId: oid("c") };
  const h = setup(); await h.runtime.activate();
  const accepted = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("out", args, undefined, undefined, context("out", args)); assert.equal(accepted.terminate, true);
  for (const state of [
    { mergeCommitId: oid("c"), parentObjectIds: [oid("b"), oid("a")], unmergedPaths: [], worktreeClean: true, resolutionChangedPaths: ["same.txt"] },
    { mergeCommitId: oid("c"), parentObjectIds: [oid("a"), oid("b")], unmergedPaths: ["same.txt"], worktreeClean: true, resolutionChangedPaths: ["same.txt"] },
    { mergeCommitId: oid("c"), parentObjectIds: [oid("a"), oid("b")], unmergedPaths: [], worktreeClean: false, resolutionChangedPaths: ["same.txt"] },
    { mergeCommitId: oid("c"), parentObjectIds: [oid("a"), oid("b")], unmergedPaths: [], worktreeClean: true, resolutionChangedPaths: ["same.txt", "unrelated.txt"] },
  ]) { let aborted = 0; const bad = setup({ gitState: { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async () => state } }); await bad.runtime.activate(); await assert.rejects(bad.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("bad", args, undefined, undefined, context("bad", args, 1, () => aborted++)), /verification/); assert.equal(aborted, 1); }
});
