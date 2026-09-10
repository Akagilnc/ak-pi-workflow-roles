/**
 * #836 删 8: reviewer code must not compile/spawn axis children.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { executeReviewerChild } from "../../src/reviewer-child-executor.ts";
import { createReviewerAgentRunner } from "../../src/reviewer-agent.ts";
import { constructReviewerDispatch } from "../../src/reviewer-construction.ts";

const pin = {
  repositoryRoot: "/repo",
  objectFormat: "sha1" as const,
  targetHead: "abc",
  refs: {},
};
const range = {
  target: "HEAD",
  base: "main",
  diffCommand: "git diff",
  diffSha256: "0".repeat(64),
  commits: [] as const,
};

test("executeReviewerChild is deleted and throws if called", async () => {
  await assert.rejects(
    () => executeReviewerChild("/tmp/ws", { axis: "standards", prompt: "axis=standards" } as never, {} as never),
    /#836: executeReviewerChild deleted/,
  );
});

test("reviewer agent run does not spawn children — deferredToParentCodeReviewSkill", async () => {
  const dispatch = constructReviewerDispatch({
    identity: "id-1",
    canonicalSkill: "skill",
    target: pin,
    range,
    specAuthority: { status: "missing" },
  });
  // construct only emits axis tokens
  assert.equal(dispatch.legs[0]!.prompt, "axis=standards");
  const runner = createReviewerAgentRunner();
  const result = await runner.run(
    {
      ...dispatch,
      targetSnapshot: pin,
    } as never,
    { context: {} as never },
  );
  assert.equal(result.legs.standards.status, "successful");
  assert.deepEqual(result.legs.standards.report, { deferredToParentCodeReviewSkill: true });
  assert.equal(result.legs.standards.workspaceDisposition, "not-created");
});
