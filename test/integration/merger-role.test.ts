import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiRoleHostAdapter } from "../../src/pi/adapter.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { sha256Hex } from "../../src/sha256.ts";
import { createMergerRoleRuntime } from "../../src/merger-role.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { activationExtensionContext, packageRoot, withHermeticHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const oid = (c: string) => c.repeat(40);
const mat = (s: string) => ({ bytesBase64: Buffer.from(s).toString("base64"), sha256: sha256Hex(s) });
const input = { version: 1 as const, attemptId: "attempt", targetObjectId: oid("a"), sourceObjectId: oid("b"), materials: { task: mat("task"), authority: mat("authority"), targetIntent: mat("target intent"), sourceIntent: mat("source intent") }, expectedConflictPaths: ["same.txt"], resolutionScope: ["same.txt"], authorizedChecks: [{ name: "test", argv: ["npm", "test"] }] };
function harness(flag: unknown = "/input.json") { const flags = new Map<string, unknown>([["ak-merger-input", flag]]); const tools = new Map<string, any>(); const handlers = new Map<string, any>(); let active: string[] = []; const host = ["read", "grep", "find", "ls", "bash", "write", "edit", "Agent", "web"]; const pi = { registerFlag(name: string) { if (!flags.has(name)) flags.set(name, undefined); }, getFlag(name: string) { return flags.get(name); }, registerTool(tool: any) { tools.set(tool.name, tool); }, getAllTools() { return [...host, ...tools.keys()].map(name => ({ name })); }, setActiveTools(names: string[]) { active = names; }, getActiveTools() { return active; }, on(name: string, fn: any) { handlers.set(name, fn); } }; return { pi, tools, handlers, active: () => active }; }
function context(id: string, args: Record<string, unknown>, calls = 1, abort = () => {}): ExtensionContext { const sessionManager = SessionManager.inMemory(); const content = Array.from({ length: calls }, (_, i) => ({ type: "toolCall" as const, id: i ? `sibling-${i}` : id, name: i ? "bash" : MERGER_OUTPUT_TOOL_NAME, arguments: i ? {} : args })); const message: AssistantMessage = { role: "assistant", content, api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 }; sessionManager.appendMessage(message); return { cwd: process.cwd(), sessionManager, abort, mode: "json" } as unknown as ExtensionContext; }
function setup(overrides: any = {}) { const h = harness(); let completedCalls = 0; const runtime = createMergerRoleRuntime(createPiRoleHostAdapter(h.pi as unknown as ExtensionAPI).host, { loadSoul: async () => "MERGER LAW", loadInput: async () => input, gitState: { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async (id: string, tree: string) => { completedCalls++; assert.equal(tree, oid("d")); return { mergeCommitId: id, parentObjectIds: [oid("a"), oid("b")], unmergedPaths: [], worktreeClean: true, resolutionChangedPaths: ["same.txt"] }; } }, ...overrides }, { failInfrastructure(error: unknown, ctx): never { ctx.abort(); throw error; } }); return { ...h, runtime, completedCalls: () => completedCalls }; }


const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** One conflicted-repo template per process; cases clone locally. */
let conflictedTemplateMemo: Promise<{ root: string; source: string; target: string }> | undefined;
async function conflictedTemplate() {
  conflictedTemplateMemo ??= (async () => {
    const root = await mkdtemp(resolve(tmpdir(), "ak-merger-conflict-template-"));
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Merger Test");
    git(root, "config", "user.email", "merger@test.local");
    await writeFile(resolve(root, "same.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    git(root, "checkout", "-b", "source");
    await writeFile(resolve(root, "same.txt"), "source\n");
    git(root, "commit", "-am", "source");
    const source = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    await writeFile(resolve(root, "same.txt"), "target\n");
    git(root, "commit", "-am", "target");
    const target = git(root, "rev-parse", "HEAD");
    return { root, source, target };
  })();
  return conflictedTemplateMemo;
}

async function materializeConflictedRepo() {
  const template = await conflictedTemplate();
  const cwd = await mkdtemp(resolve(tmpdir(), "ak-merger-session-b-"));
  execFileSync("git", ["clone", "--local", "--quiet", template.root, cwd], { stdio: "ignore" });
  git(cwd, "config", "user.name", "Merger Test");
  git(cwd, "config", "user.email", "merger@test.local");
  git(cwd, "branch", "source", "origin/source");
  assert.throws(() => git(cwd, "merge", "--no-edit", "source"));
  return {
    cwd,
    source: git(cwd, "rev-parse", "source"),
    target: git(cwd, "rev-parse", "HEAD"),
  };
}

test("production extension observes session repository B, not ambient repository A, through activation and completion", async () => {
  const fixture = await materializeConflictedRepo();
  const repositoryB = fixture.cwd;
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  try {
    const source = fixture.source;
    const target = fixture.target;
    const resolutionBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repositoryB, input: "resolved\n", encoding: "utf8" }).trim();
    const temporaryIndex = resolve(repositoryB, "expected-index");
    execFileSync("git", ["read-tree", "AUTO_MERGE^{tree}"], { cwd: repositoryB, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${resolutionBlob},same.txt`], { cwd: repositoryB, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    const tree = execFileSync("git", ["write-tree"], { cwd: repositoryB, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex }, encoding: "utf8" }).trim();
    const mergeCommitId = execFileSync("git", ["commit-tree", tree, "-p", target, "-p", source, "-m", "resolve"], { cwd: repositoryB, env, encoding: "utf8" }).trim();
    const realInput = { ...input, targetObjectId: target, sourceObjectId: source };
    const inputPath = resolve(repositoryB, "input.json"); await writeFile(inputPath, JSON.stringify(realInput));
    await writeFile(resolve(repositoryB, ".git/info/exclude"), "input.json\nexpected-index\n");
    await withHermeticHome({ prefix: "ak-merger-production-extension-" }, async ({ agentDir }) => {
      // #443: merger session materials via production role-runtime wiring.
      const mergerSoul = [
        await readFile(resolve(packageRoot, "CLAUDE.md"), "utf8"),
        await readFile(resolve(packageRoot, "souls/merger.md"), "utf8"),
      ].join("\n\n").trim();
      const faux = fauxProvider({ api: "merger-session-cwd", provider: "merger-session-cwd" });
      let mergerContext: Context | undefined;
      faux.setResponses([
        (context: Context) => {
          mergerContext = context;
          return fauxAssistantMessage(fauxToolCall("bash", { command: `git reset --hard ${mergeCommitId}` }, { id: "resolve" }), { stopReason: "toolUse" });
        },
        fauxAssistantMessage(fauxToolCall(MERGER_OUTPUT_TOOL_NAME, { status: "completed", attemptId: "attempt", report: "resolved", mergeCommitId }, { id: "out" }), { stopReason: "toolUse" }),
      ]);
      await withInProcessPi({ activationLedgerSession: true, cwd: repositoryB, agentDir, faux, modelsPath: null, noExtensions: true, systemPrompt: "MERGER", mode: "print", flags: { "ak-role": "merger", "ak-merger-input": inputPath }, additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/role-runtime.ts", import.meta.url))] }, async ({ session, sessionManager }) => {
        await session.prompt("Resolve and settle.");
        assert.ok(mergerContext);
        assert.ok(
          mergerContext.systemPrompt?.includes(
            `<merger_soul>\n${mergerSoul}\n</merger_soul>`,
          ),
          "provider receives constitution + merger soul from production role-runtime",
        );
        const result = sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === MERGER_OUTPUT_TOOL_NAME) as any;
        assert.equal(result?.message.isError, false, JSON.stringify(result?.message.content)); assert.equal(result?.message.details.mergeCommitId, mergeCommitId);
      });
    });
  } finally { await rm(repositoryB, { recursive: true, force: true }); }
});

test("role extension binds Merger Git state to session cwd while preserving injected state", async () => {
  await withHermeticHome({ prefix: "ak-merger-bind-cwd-" }, async ({ home }) => {
    for (const injected of [false, true]) {
      const h = harness();
      h.pi.getFlag = (name: string) => name === "ak-role" ? "merger" : name === "ak-merger-input" ? "/input.json" : undefined;
      const roots: string[] = [];
      const states: object[] = [];
      const state = { activeMerge: async () => ({ targetObjectId: oid("a"), sourceObjectId: oid("b"), unmergedPaths: ["same.txt"], automaticMergeTreeId: oid("d") }), completedMerge: async () => { throw new Error("unused"); } };
      createRoleRuntimeExtension({
        loadJudgeSoul: async () => "unused", transcriptFromContext: () => "unused", auditSoulCompliance: async () => ({ status: "pass", violations: [] }),
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

test("Merger activation preflights frozen identity and narrows to the exact resolution tools", async () => {
  const h = setup(); await h.runtime.activate();
  assert.deepEqual(h.active(), ["read", "grep", "find", "ls", "bash", "write", "edit", MERGER_OUTPUT_TOOL_NAME]);
  const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, context("prompt", {}));
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
  await assert.rejects(h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("again", args, undefined, undefined, context("again", args)));
});

test("Merger terminal contract and singleton failures abort without accepting a receipt", async () => {
  const valid = { status: "escalate", attemptId: "attempt", diagnosis: "new product decision", report: "both authorized intents cannot coexist" };
  for (const { args, calls } of [
    { args: { ...valid, attemptId: "wrong" }, calls: 1 },
    { args: valid, calls: 2 },
  ]) {
    const h = setup(); await h.runtime.activate(); let aborted = 0;
    const rejection = h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("out", args, undefined, undefined, context("out", args, calls, () => aborted++));
    await assert.rejects(rejection);
    assert.equal(aborted, 1);
    const accepted = await h.tools.get(MERGER_OUTPUT_TOOL_NAME).execute("accepted", valid, undefined, undefined, context("accepted", valid));
    assert.equal(accepted.terminate, true);
  }
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
