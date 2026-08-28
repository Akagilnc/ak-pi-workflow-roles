// #541 Reviewer output-tool wiring: the shortest existing reviewer fixtures do
// not reach the output execute seam, so this lowest-reachable-layer test covers
// the shared infrastructure-failure declaration path (judge: only add here when
// an existing fixture cannot reach it).
import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createReviewerRoleRuntime, REVIEWER_OUTPUT_TOOL_NAME } from "../../src/reviewer-role.ts";

const skill = "# code-review\nreview carefully.";

function reviewerDeps(hostActions: { failInfrastructure(error: unknown, ctx: unknown, toolCallId?: string): never }) {
  return {
    loadSoul: async () => "REVIEWER LAW",
    loadCanonicalSkillBinding: async () => ({
      name: "code-review" as const,
      snapshot: { raw: skill, path: "/skill", baseDir: "/", body: skill, snapshotIdentity: Object.freeze({ text: skill }) },
      invocation: (request: string) => request,
      captureExpansion: (_prompt: string, originalRequest: string) => ({ name: "code-review" as const, location: "/skill", content: skill, userMessage: originalRequest }),
    }),
    createPinnedGitReader: async () => ({
      pin: { repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "target", refs: {} },
      snapshot: async () => ({ repositoryRoot: "/repo", objectFormat: "sha1" as const, targetHead: "target", refs: {} }),
      resolve: async () => "base",
      range: async () => ({ base: "base", target: "target", diffCommand: "git diff", diffSha256: "a".repeat(64), commits: ["target"] }),
      featureTokens: async () => Object.freeze([]),
      listSpecCandidatePaths: async () => Object.freeze([]),
      originRepository: async () => undefined,
      commitMessagesNewestFirst: async () => Object.freeze([]),
      readPinnedText: async () => undefined,
    }),
    runDispatch: async () => { throw new Error("dispatch must not run for an infrastructure-failure declaration"); },
  };
}

test("Reviewer output routes an infrastructure-failure declaration to the host before any ledger projection", async () => {
  const tools = new Map<string, any>();
  let hostCalls = 0;
  const pi = {
    registerFlag() {},
    getFlag() { return undefined; },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getAllTools() { return [{ name: "read" }, { name: "write" }, { name: "bash" }]; },
    setActiveTools() {},
    getActiveTools() { return []; },
    on() {},
  };
  const hostActions = {
    failInfrastructure(error: unknown, _ctx: unknown, id?: string) {
      hostCalls += 1;
      assert.equal(id, "infra");
      throw error instanceof Error ? error : new Error(String(error));
    },
  };
  const runtime = createReviewerRoleRuntime(pi as unknown as ExtensionAPI, reviewerDeps(hostActions), hostActions);
  await runtime.activate(undefined, { baseRevision: "review-base" });
  const output = tools.get(REVIEWER_OUTPUT_TOOL_NAME);
  assert.ok(output, "Reviewer output tool must be registered after activation");
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "infra", name: REVIEWER_OUTPUT_TOOL_NAME, arguments: {} }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  });
  const parameters = { infrastructureFailure: { diagnostic: "reviewer engine 541" } };
  await assert.rejects(
    output.execute("infra", parameters, undefined, undefined, { sessionManager }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "reviewer engine 541");
      return true;
    },
  );
  assert.equal(hostCalls, 1, "the reviewer infra declaration reaches the host exactly once");
});
