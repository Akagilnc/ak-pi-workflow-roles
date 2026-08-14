import assert from "node:assert/strict";
import test from "node:test";
import {
  constructReviewerDispatch,
  reviewerAuthorityRefsMaterial,
} from "../../src/reviewer-construction.ts";
import { createReviewerDispatcher, type AcceptedReviewerExecution, type ReviewerPinnedGitReader, type ReviewerPinnedTarget } from "../../src/reviewer-dispatch.ts";

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
function harness(
  snapshot = pin,
  options: {
    authorityRefs?: readonly string[];
    /** Branch/feature tokens returned by the pinned reader (production discovery input). */
    featureTokens?: readonly string[];
  } = {},
) {
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
    async featureTokens() {
      return Object.freeze([...(options.featureTokens ?? [])]);
    },
  };
  const dispatcher = createReviewerDispatcher({
    canonicalSkill: "review skill",
    reader,
    ...(options.authorityRefs === undefined ? {} : { authorityRefs: options.authorityRefs }),
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

test("production discovery: bare commit #N without durable source skips Spec", async () => {
  // No supplied refs, no matchable feature tokens ⇒ unique owner yields missing.
  // Bare tracker numbers in commit messages are not durable Spec material.
  const h = harness(pin, { featureTokens: [] });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "skipped-missing");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards"]);
  assert.deepEqual(result.dispatch.authorityRefs, []);
  assert.deepEqual(h.execution?.legs.map((leg) => leg.axis), ["standards"]);
});

test("production discovery: supplied authorityRefs launch Spec with material", async () => {
  const refs = Object.freeze(["https://example.com/spec"]);
  const h = harness(pin, {
    authorityRefs: refs,
    featureTokens: [],
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards", "spec"]);
  assert.deepEqual(result.dispatch.authorityRefs, [...refs]);
  const material = reviewerAuthorityRefsMaterial(refs);
  assert.equal(result.dispatch.legs.find((leg) => leg.axis === "standards")?.prompt.includes("Authority-Refs:"), false);
  assert.equal(result.dispatch.legs.find((leg) => leg.axis === "spec")?.prompt.includes(material), true);
  assert.equal(h.execution?.legs.find((leg) => leg.axis === "spec")?.prompt.includes(material), true);
});

test("construction builds solely from discovery product (no secondary launch decision)", () => {
  const missing = constructReviewerDispatch({
    identity: "id-missing",
    canonicalSkill: "review skill",
    target: pin,
    range,
    specAuthority: { status: "missing" },
  });
  assert.equal(missing.specDisposition, "skipped-missing");
  assert.deepEqual(missing.legs.map((leg) => leg.axis), ["standards"]);
  assert.deepEqual(missing.authorityRefs, []);

  const refs = Object.freeze(["docs/feature-login.md"]);
  const available = constructReviewerDispatch({
    identity: "id-available",
    canonicalSkill: "review skill",
    target: pin,
    range,
    specAuthority: { status: "available", refs },
  });
  assert.equal(available.specDisposition, "launched");
  assert.deepEqual(available.legs.map((leg) => leg.axis), ["standards", "spec"]);
  assert.deepEqual(available.authorityRefs, [...refs]);
  assert.equal(
    available.legs.find((leg) => leg.axis === "spec")?.prompt.includes(reviewerAuthorityRefsMaterial(refs)),
    true,
  );
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
  const h = harness(pin, {
    authorityRefs: ["https://example.com/spec"],
  });
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

test("settlement records skipped-missing Spec disposition without Spec leg", async () => {
  const { assembleRuntimeReviewerReceipt } = await import("../../src/reviewer-settlement.ts");
  const constructed = constructReviewerDispatch({
    identity: "dispatch-missing-spec",
    canonicalSkill: "review skill",
    target: pin,
    range,
    specAuthority: { status: "missing" },
  });
  assert.equal(constructed.specDisposition, "skipped-missing");
  const standardsPrompt = constructed.legs[0]!.prompt;
  const assembled = assembleRuntimeReviewerReceipt({
    intent: { status: "completed" },
    canonicalSkillText: "review skill",
    record: {
      rejections: [],
      accepted: {
        identity: constructed.identity,
        recipe: constructed.recipe,
        input: constructed.input,
        target: constructed.targetSnapshot,
        range: constructed.range,
        authorityRefs: constructed.authorityRefs,
        specDisposition: constructed.specDisposition,
        legs: constructed.legs,
      },
      started: { dispatchIdentity: constructed.identity, cardinality: 1 },
      results: {
        standards: {
          dispatchIdentity: constructed.identity,
          axis: "standards",
          status: "successful",
          prompt: standardsPrompt,
          target: pin,
          workspaceDisposition: "deleted",
          report: "Standards finding count: 0.",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    },
  });
  assert.equal(assembled.specDisposition, "skipped-missing");
  assert.deepEqual(
    assembled.acceptedBatch?.legs.map((leg) => leg.axis),
    ["standards"],
  );
  assert.equal(assembled.reports.spec, undefined);
  assert.equal(assembled.outcomes.spec, undefined);
  assert.equal(assembled.reports.standards?.text, "Standards finding count: 0.");
});
