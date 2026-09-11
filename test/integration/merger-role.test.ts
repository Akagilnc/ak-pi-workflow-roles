// #685 C1: withInProcessPi host leg culled. C3: session B≠ambient A 未结 —
// docs/research/issue-685-c3-deleted-contract-handoff.md §C.
// #827: activation/completion Git gates deleted; handler records once.
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
import { createPiRoleRuntimeExtension, createPiRoleHostAdapter } from "../../src/pi/adapter.ts";
import { activationExtensionContext, withHermeticHome } from "../helpers/pi-test-harness.ts";

const oid = (c: string) => c.repeat(40);
const mat = (s: string) => ({ bytesBase64: Buffer.from(s).toString("base64"), sha256: sha256Hex(s) });
const input = { attemptId: "attempt", targetObjectId: oid("a"), sourceObjectId: oid("b"), materials: { task: mat("task"), authority: mat("authority"), targetIntent: mat("target intent"), sourceIntent: mat("source intent") }, expectedConflictPaths: ["same.txt"], resolutionScope: ["same.txt"], authorizedChecks: [{ name: "test", argv: ["npm", "test"] }] };

/** Grok-shaped host surface: getAllTools starts AK-empty; no Pi builtin names required. */
function harness(flag: unknown = "/input.json") { const flags = new Map<string, unknown>([["ak-merger-input", flag]]); const tools = new Map<string, any>(); const handlers = new Map<string, any>(); let active: string[] = []; const pi = { registerFlag(name: string) { if (!flags.has(name)) flags.set(name, undefined); }, getFlag(name: string) { return flags.get(name); }, registerTool(tool: any) { tools.set(tool.name, tool); }, getAllTools() { return [...tools.keys()].map(name => ({ name })); }, setActiveTools(names: string[]) { active = names; }, getActiveTools() { return active; }, on(name: string, fn: any) { handlers.set(name, fn); } }; return { pi, tools, handlers, active: () => active }; }
function context(id: string, args: Record<string, unknown>, calls = 1, abort = () => {}): ExtensionContext { const sessionManager = SessionManager.inMemory(); const content = Array.from({ length: calls }, (_, i) => ({ type: "toolCall" as const, id: i ? `sibling-${i}` : id, name: i ? "bash" : MERGER_OUTPUT_TOOL_NAME, arguments: i ? {} : args })); const message: AssistantMessage = { role: "assistant", content, api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 }; sessionManager.appendMessage(message); return { cwd: process.cwd(), sessionManager, abort, mode: "json" } as unknown as ExtensionContext; }
function setup(overrides: any = {}) { const h = harness(); const runtime = createMergerRoleRuntime(createPiRoleHostAdapter(h.pi as unknown as ExtensionAPI).host, { loadSoul: async () => "MERGER LAW", loadInput: async () => input, ...overrides }); return { ...h, runtime }; }

test("role extension activates Merger without Git state dependency", async () => {
  await withHermeticHome({ prefix: "ak-merger-bind-cwd-" }, async ({ home }) => {
    const h = harness();
    h.pi.getFlag = (name: string) => name === "ak-role" ? "merger" : name === "ak-merger-input" ? "/input.json" : undefined;
    createPiRoleRuntimeExtension({ loadJudgeSoul: async () => "unused", loadMergerSoul: async () => "MERGER LAW", loadMergerInput: async () => input })(h.pi as unknown as ExtensionAPI);
    const repoA = join(home, "repository-a");
    mkdirSync(repoA, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoA, stdio: "ignore" });
    await h.handlers.get("session_start")({}, activationExtensionContext({ cwd: repoA, home }));
    assert.equal([...h.tools.keys()].includes(MERGER_OUTPUT_TOOL_NAME), true);
  });
});

test("Merger activation preflights host-neutral AK tool surface without Git gates", async () => {
  const h = setup(); await h.runtime.activate();
  assert.deepEqual(h.active(), []);
  assert.equal([...h.tools.keys()].filter((name) => name === MERGER_OUTPUT_TOOL_NAME).length, 1);
});

test("Merger activates with empty conflict materials (no in-progress merge assignment)", async () => {
  const empty = { ...input, targetObjectId: oid("a"), sourceObjectId: "", expectedConflictPaths: [], resolutionScope: [] };
  const h = setup({ loadInput: async () => empty });
  await h.runtime.activate();
  assert.equal([...h.tools.keys()].includes(MERGER_OUTPUT_TOOL_NAME), true);
});

test("Merger accepts one honest escalation without Git success verification", async () => {
  const h = setup(); await h.runtime.activate();
  const args = { status: "escalate", attemptId: "attempt", diagnosis: "no in-progress merge", report: "nothing to reconcile" };
  const result = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("out", args, undefined, undefined, context("out", args));
  assert.equal(result.terminate, true); assert.deepEqual(result.details, args);
  // #836: the submission tool records every call — it does not abort, seal, or
  // reject a second call. Host end (not the tool) is the sole final.
  const again = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("again", args, undefined, undefined, context("again", args));
  assert.equal(again.terminate, true); assert.deepEqual(again.details, args);
});

test("Merger accepts completed receipt without path-scope/completion Git verification gate", async () => {
  const args = { status: "completed", attemptId: "attempt", report: "resolved", mergeCommitId: oid("c") };
  const h = setup(); await h.runtime.activate();
  const accepted = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("out", args, undefined, undefined, context("out", args));
  assert.equal(accepted.terminate, true);
  assert.equal(accepted.details.status, "completed");
  assert.deepEqual(accepted.details, args);
});
