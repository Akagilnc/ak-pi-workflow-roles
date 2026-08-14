import assert from "node:assert/strict";
import test from "node:test";
import {
  constructReviewerDispatch,
  reviewerAuthorityRefsMaterial,
  shouldLaunchSpecEvidenceChild,
  type ReviewerSpecAuthorityDiscovery,
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
    specAuthorityDiscovery?: ReviewerSpecAuthorityDiscovery;
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
  };
  const dispatcher = createReviewerDispatcher({
    canonicalSkill: "review skill",
    reader,
    ...(options.authorityRefs === undefined ? {} : { authorityRefs: options.authorityRefs }),
    ...(options.specAuthorityDiscovery === undefined
      ? {}
      : { specAuthorityDiscovery: options.specAuthorityDiscovery }),
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

test("fixed dispatch launches independent Standards and Spec legs by default", async () => {
  const h = harness();
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  assert.deepEqual(h.execution?.legs.map((x) => x.axis), ["standards", "spec"]);
  if (result.status === "accepted") {
    assert.equal(result.dispatch.specDisposition, "launched");
  }
});

test("absence of authorityRefs is not treated as missing Spec", () => {
  assert.equal(shouldLaunchSpecEvidenceChild({ authorityRefs: [] }), true);
  assert.equal(
    shouldLaunchSpecEvidenceChild({
      authorityRefs: [],
      specAuthorityDiscovery: { status: "available" },
    }),
    true,
  );
  const constructed = constructReviewerDispatch({
    identity: "id",
    canonicalSkill: "review skill",
    target: pin,
    range,
  });
  assert.equal(constructed.specDisposition, "launched");
  assert.deepEqual(constructed.legs.map((leg) => leg.axis), ["standards", "spec"]);
});

test("confirmed missing Spec skips Spec child with honest skipped-missing disposition", async () => {
  const constructed = constructReviewerDispatch({
    identity: "id",
    canonicalSkill: "review skill",
    target: pin,
    range,
    specAuthorityDiscovery: { status: "missing" },
  });
  assert.equal(constructed.specDisposition, "skipped-missing");
  assert.deepEqual(constructed.legs.map((leg) => leg.axis), ["standards"]);
  assert.equal(constructed.legs.some((leg) => leg.axis === "spec"), false);

  const h = harness(pin, { specAuthorityDiscovery: { status: "missing" } });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "skipped-missing");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards"]);
  assert.deepEqual(h.execution?.legs.map((leg) => leg.axis), ["standards"]);
});

test("supplied authorityRefs keep Spec child even when discovery says missing", async () => {
  const refs = Object.freeze(["https://example.com/spec"]);
  const constructed = constructReviewerDispatch({
    identity: "id",
    canonicalSkill: "review skill",
    target: pin,
    range,
    authorityRefs: refs,
    specAuthorityDiscovery: { status: "missing" },
  });
  assert.equal(constructed.specDisposition, "launched");
  assert.deepEqual(constructed.legs.map((leg) => leg.axis), ["standards", "spec"]);
  const spec = constructed.legs.find((leg) => leg.axis === "spec");
  assert.equal(spec?.prompt.includes(reviewerAuthorityRefsMaterial(refs)), true);

  const h = harness(pin, {
    authorityRefs: refs,
    specAuthorityDiscovery: { status: "missing" },
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards", "spec"]);
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

test("settlement records skipped-missing Spec disposition without Spec leg", async () => {
  const { assembleRuntimeReviewerReceipt } = await import("../../src/reviewer-settlement.ts");
  const constructed = constructReviewerDispatch({
    identity: "dispatch-missing-spec",
    canonicalSkill: "review skill",
    target: pin,
    range,
    specAuthorityDiscovery: { status: "missing" },
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

test("authorityRefs inject only into Spec evidence-child material unchanged", async () => {
  const refs = Object.freeze([
    "https://github.com/Akagilnc/ming-salvage-sim/issues/1185",
    "https://github.com/Akagilnc/ming-salvage-sim/issues/1185#issuecomment-5290856369",
  ]);
  const constructed = constructReviewerDispatch({
    identity: "id",
    canonicalSkill: "review skill",
    target: pin,
    range,
    authorityRefs: refs,
  });
  assert.deepEqual(constructed.authorityRefs, [...refs]);
  const standards = constructed.legs.find((leg) => leg.axis === "standards");
  const spec = constructed.legs.find((leg) => leg.axis === "spec");
  assert.ok(standards);
  assert.ok(spec);
  const material = reviewerAuthorityRefsMaterial(refs);
  assert.equal(standards!.prompt.includes("Authority-Refs:"), false);
  assert.equal(standards!.prompt.includes(material), false);
  assert.equal(spec!.prompt.includes(material), true);
  assert.equal(
    spec!.prompt.includes(JSON.stringify([...refs])),
    true,
  );

  const h = harness(pin, { authorityRefs: refs });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.deepEqual(result.dispatch.authorityRefs, [...refs]);
  const dispatchedStandards = result.dispatch.legs.find((leg) => leg.axis === "standards");
  const dispatchedSpec = result.dispatch.legs.find((leg) => leg.axis === "spec");
  assert.equal(dispatchedStandards?.prompt.includes("Authority-Refs:"), false);
  assert.equal(dispatchedSpec?.prompt.includes(material), true);
  assert.equal(h.execution?.legs.find((leg) => leg.axis === "standards")?.prompt.includes("Authority-Refs:"), false);
  assert.equal(h.execution?.legs.find((leg) => leg.axis === "spec")?.prompt.includes(material), true);
});
