import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CanonicalSkillBinding } from "../../src/canonical-skill-binding.ts";
import {
  REVIEWER_AXIS_OUTPUT_ADAPTER,
  REVIEWER_VERIFICATION_BOUNDARY,
} from "../../src/reviewer-construction.ts";
import { createReviewerDispatcher, type AcceptedReviewerExecution, type ReviewerPinnedGitReader, type ReviewerPinnedTarget } from "../../src/reviewer-dispatch.ts";
import { createReviewerRoleRuntime } from "../../src/reviewer-role.ts";

const pin: ReviewerPinnedTarget = {
  repositoryRoot: "/repo",
  objectFormat: "sha1",
  targetHead: "target",
  refs: {
    "refs/heads/main": { objectId: "1".repeat(40), peeledCommitId: "1".repeat(40) },
  },
};
const range = {
  base: "base",
  target: "target",
  diffCommand: "git diff base...target",
  diffSha256: "1".repeat(64),
  commits: ["target"],
};
function harness(snapshot = pin) {
  let execution: AcceptedReviewerExecution | undefined;
  const reader: ReviewerPinnedGitReader = {
    pin,
    async snapshot() {
      return snapshot;
    },
    async resolve() {
      return "base";
    },
    async range() {
      return range;
    },
  };
  const dispatcher = createReviewerDispatcher({
    canonicalSkill: "review skill",
    reader,
    async run(value) {
      execution = value;
      return "done";
    },
  });
  return {
    dispatcher,
    get execution() {
      return execution;
    },
  };
}

test("fixed dispatch always launches independent Standards and Spec legs", async () => {
  const h = harness();
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  assert.deepEqual(h.execution?.legs.map((x) => x.axis), ["standards", "spec"]);
});

test("targetHead drift prevents child execution", async () => {
  const h = harness({ ...pin, targetHead: "other" });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    assert.deepEqual(result.violations, ["target-drift"]);
    assert.match(result.diagnostic, /pinned target/);
  }
  assert.equal(h.execution, undefined);
});

test("sibling ref map drift does not reject dispatch", async () => {
  const h = harness({
    ...pin,
    refs: {
      ...pin.refs,
      "refs/heads/sibling-writer": {
        objectId: "2".repeat(40),
        peeledCommitId: "2".repeat(40),
      },
    },
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  assert.ok(h.execution);
});

test("constructed legs exclude caller task channel", async () => {
  const h = harness();
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  for (const leg of result.dispatch.legs) {
    assert.equal(leg.prompt.includes("Task:"), false);
    assert.equal(leg.prompt.includes("supplied task"), false);
    assert.equal(leg.prompt.includes("review task"), false);
    assert.match(leg.prompt, /Canonical-Skill:/);
    assert.match(leg.prompt, /Fixed-Range:/);
  }
  assert.equal("task" in result.dispatch.input, false);
  assert.equal(result.dispatch.input.canonicalSkill, "review skill");
});

test("constructed legs carry typed axis adapter without verification-boundary carrier", async () => {
  const h = harness();
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;

  const axes = result.dispatch.legs.map((leg) => leg.axis).sort();
  assert.deepEqual(axes, ["spec", "standards"]);
  for (const leg of result.dispatch.legs) {
    // Axis legs own adapter identity only; verification cadence rides parent + evidence-child carriers.
    assert.equal(
      leg.prompt.includes(
        `Axis-Output-Adapter: ${REVIEWER_AXIS_OUTPUT_ADAPTER.adapterId}@${REVIEWER_AXIS_OUTPUT_ADAPTER.version}:${leg.axis}`,
      ),
      true,
      `${leg.axis} missing typed axis adapter`,
    );
    assert.equal(
      leg.prompt.includes(REVIEWER_VERIFICATION_BOUNDARY),
      false,
      `${leg.axis} must not duplicate verification carrier into axis legs`,
    );
  }
});

test("parent Reviewer system prompt injects package-owned verification boundary once", async () => {
  const flags = new Map<string, unknown>([["ak-review-base", "main~1"]]);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    registerFlag(name: string) {
      if (!flags.has(name)) flags.set(name, undefined);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerTool() {},
    on(name: string, fn: (...args: any[]) => unknown) {
      handlers.set(name, fn);
    },
  };
  const binding = {
    name: "code-review",
    snapshot: {
      raw: "review skill",
      path: "/skill/code-review/SKILL.md",
      baseDir: "/skill/code-review",
      body: "review skill",
      snapshotIdentity: { text: "review skill" },
    },
    invocation(originalRequest: string) {
      return `/skill:code-review ${originalRequest}`;
    },
    captureExpansion(prompt: string, originalRequest: string) {
      if (!prompt.includes(originalRequest)) return undefined;
      return {
        name: "code-review" as const,
        location: "/skill/code-review/SKILL.md",
        content: "review skill",
        userMessage: originalRequest,
      };
    },
  } satisfies CanonicalSkillBinding<"code-review">;
  const runtime = createReviewerRoleRuntime(
    pi as unknown as ExtensionAPI,
    {
      loadSoul: async () => "REVIEWER LAW",
      loadCanonicalSkillBinding: async () => binding,
      createPinnedGitReader: async () => ({
        pin,
        async snapshot() {
          return pin;
        },
        async resolve() {
          return "base";
        },
        async range() {
          return range;
        },
      }),
      runDispatch: async () => {
        throw new Error("dispatch should not run in prompt injection test");
      },
      auditCompliance: async () => ({ status: "pass" as const }),
    },
    {
      failInfrastructure(error) {
        throw error;
      },
    },
  );
  await runtime.activate();
  await handlers.get("input")!({ text: "review since main~1" });
  const prompt = await handlers.get("before_agent_start")!(
    { systemPrompt: "BASE", prompt: "review since main~1 expanded" },
    {} as ExtensionContext,
  ) as { systemPrompt: string };
  assert.equal(prompt.systemPrompt.includes("REVIEWER LAW"), true);
  assert.equal(prompt.systemPrompt.includes(REVIEWER_VERIFICATION_BOUNDARY), true);
  assert.equal(prompt.systemPrompt.includes("<reviewer_verification_boundary>"), true);
  assert.equal(prompt.systemPrompt.includes("</reviewer_verification_boundary>"), true);
  assert.equal(
    prompt.systemPrompt.split(REVIEWER_VERIFICATION_BOUNDARY).length - 1,
    1,
  );
});
