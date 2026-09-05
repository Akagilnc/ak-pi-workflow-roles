// #685 C1: withInProcessPi/createAgentSession host legs culled; production dossiers succeed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import { sha256Hex } from "../../src/sha256.ts";
import { createMergerRoleRuntime } from "../../src/merger-role.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { createPiRoleHostAdapter } from "../../src/pi/adapter.ts";
import { activationExtensionContext, withHermeticHome } from "../helpers/pi-test-harness.ts";

const oid = (c: string) => c.repeat(40);
const mat = (s: string) => ({ bytesBase64: Buffer.from(s).toString("base64"), sha256: sha256Hex(s) });
const input = { version: 1 as const, attemptId: "attempt", targetObjectId: oid("a"), sourceObjectId: oid("b"), materials: { task: mat("task"), authority: mat("authority"), targetIntent: mat("target intent"), sourceIntent: mat("source intent") }, expectedConflictPaths: ["same.txt"], resolutionScope: ["same.txt"], authorizedChecks: [{ name: "test", argv: ["npm", "test"] }] };
/** Grok-shaped host surface: getAllTools starts AK-empty; no Pi builtin names required. */
function harness(flag: unknown = "/input.json") { const flags = new Map<string, unknown>([["ak-merger-input", flag]]); const tools = new Map<string, any>(); const handlers = new Map<string, any>(); let active: string[] = []; const pi = { registerFlag(name: string) { if (!flags.has(name)) flags.set(name, undefined); }, getFlag(name: string) { return flags.get(name); }, registerTool(tool: any) { tools.set(tool.name, tool); }, getAllTools() { return [...tools.keys()].map(name => ({ name })); }, setActiveTools(names: string[]) { active = names; }, getActiveTools() { return active; }, on(name: string, fn: any) { handlers.set(name, fn); } }; return { pi, tools, handlers, active: () => active }; }
function context(id: string, args: Record<string, unknown>, calls = 1, abort = () => {}): ExtensionContext { const sessionManager = SessionManager.inMemory(); const content = Array.from({ length: calls }, (_, i) => ({ type: "toolCall" as const, id: i ? `sibling-${i}` : id, name: i ? "bash" : MERGER_OUTPUT_TOOL_NAME, arguments: i ? {} : args })); const message: AssistantMessage = { role: "assistant", content, api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 }; sessionManager.appendMessage(message); return { cwd: process.cwd(), sessionManager, abort, mode: "json" } as unknown as ExtensionContext; }
function setup(overrides: any = {}) { const h = harness(); let completedCalls = 0; const runtime = createMergerRoleRuntime(createPiRoleHostAdapter(h.pi as unknown as ExtensionAPI).host, { loadSoul: async () => "MERGER LAW", loadInput: async () => input, gitState: { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async (id: string, tree: string) => { completedCalls++; assert.equal(tree, oid("d")); return { mergeCommitId: id, parentObjectIds: [oid("a"), oid("b")], unmergedPaths: [], worktreeClean: true, resolutionChangedPaths: ["same.txt"] }; } }, ...overrides }, { failInfrastructure(error: unknown, ctx): never { ctx.abort(); throw error; } }); return { ...h, runtime, completedCalls: () => completedCalls }; }


test("role extension binds Merger Git state to session cwd while preserving injected state", async () => {
  await withHermeticHome({ prefix: "ak-merger-bind-cwd-" }, async ({ home }) => {
    for (const injected of [false, true]) {
      const h = harness();
      h.pi.getFlag = (name: string) => name === "ak-role" ? "merger" : name === "ak-merger-input" ? "/input.json" : undefined;
      const roots: string[] = [];
      const states: object[] = [];
      const state = { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async () => { throw new Error("unused"); } };
      createPiRoleRuntimeExtension({
        loadJudgeSoul: async () => "unused", auditSoulCompliance: async () => ({ status: "pass", violations: [] }),
        loadMergerSoul: async () => "MERGER LAW", loadMergerInput: async () => input,
        createMergerGitState(root) { roots.push(root); const created = { ...state }; states.push(created); return created; },
        ...(injected ? { mergerGitState: state } : {}),
      })(h.pi as unknown as ExtensionAPI);
      const repoA = join(home, `repository-a-${injected}`);
      const repoB = join(home, `repository-b-${injected}`);
      for (const repo of [repoA, repoB]) {
        mkdirSync(repo, { recursive: true });
        execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
      }
      await h.handlers.get("session_start")({}, activationExtensionContext({ cwd: repoA, home }));
      await h.handlers.get("session_start")({}, activationExtensionContext({ cwd: repoB, home }));
      assert.deepEqual(roots, injected ? [] : [repoA, repoB]);
      if (!injected) assert.notEqual(states[0], states[1]);
    }
  });
});

test("Merger activation preflights frozen identity on host-neutral AK tool surface", async () => {
  const h = setup(); await h.runtime.activate();
  // Host-neutral: activate must not require Pi builtin names or narrow active tools to them.
  assert.deepEqual(h.active(), []);
  assert.equal([...h.tools.keys()].filter((name) => name === MERGER_OUTPUT_TOOL_NAME).length, 1);
  // before_agent_start registered; material presentation bytes not locked (#685 C3).
  assert.equal(typeof h.handlers.get("before_agent_start"), "function");
  await h.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, context("prompt", {}));
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
  await assert.rejects(h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("again", args, undefined, undefined, context("again", args)));
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
