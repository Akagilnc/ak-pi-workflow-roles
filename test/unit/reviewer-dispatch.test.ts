import assert from "node:assert/strict";
import test from "node:test";
import {
  constructReviewerDispatch,
  reviewerAuthorityRefsMaterial,
  reviewerFetchedSpecMaterial,
} from "../../src/reviewer-construction.ts";
import {
  createReviewerDispatcher,
  type AcceptedReviewerExecution,
  type ReviewerIssueFetcher,
  type ReviewerPinnedGitReader,
  type ReviewerPinnedTarget,
} from "../../src/reviewer-dispatch.ts";

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

const ISSUE_BODY_WITH_ADR = [
  "# Spec for login",
  // Duplicate first path proves first-appearance order + dedupe at the real entry tracer.
  "See docs/adr/0001-roles-grow-by-demand.md then docs/adr/missing-adr.md and docs/adr/0001-roles-grow-by-demand.md again.",
].join("\n");

function harness(
  snapshot = pin,
  options: {
    authorityRefs?: readonly string[];
    ticketNumber?: number;
    /** Branch/feature tokens returned by the pinned reader (production discovery input). */
    featureTokens?: readonly string[];
    /** Pinned-target Spec candidate paths (production discovery input). */
    specCandidatePaths?: readonly string[];
    /** Optional I/O failure from pinned tree listing (must not collapse to missing). */
    listSpecError?: Error;
    origin?: { owner: string; repo: string } | undefined | "absent";
    commitMessages?: readonly string[];
    pinnedTexts?: Readonly<Record<string, string>>;
    fetchIssue?: ReviewerIssueFetcher;
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
    async listSpecCandidatePaths() {
      if (options.listSpecError !== undefined) throw options.listSpecError;
      return Object.freeze([...(options.specCandidatePaths ?? [])]);
    },
    async originRepository() {
      if (options.origin === "absent" || options.origin === undefined) return undefined;
      return Object.freeze(options.origin);
    },
    async commitMessagesNewestFirst() {
      return Object.freeze([...(options.commitMessages ?? [])]);
    },
    async readPinnedText(path: string) {
      const body = options.pinnedTexts?.[path];
      return body === undefined ? undefined : body;
    },
  };
  const dispatcher = createReviewerDispatcher({
    canonicalSkill: "review skill",
    reader,
    ...(options.authorityRefs === undefined ? {} : { authorityRefs: options.authorityRefs }),
    ...(options.ticketNumber === undefined ? {} : { ticketNumber: options.ticketNumber }),
    ...(options.fetchIssue === undefined ? {} : { fetchIssue: options.fetchIssue }),
    async run(value) {
      execution = value;
      return "done";
    },
  });
  return {
    dispatcher,
    reader,
    get execution() {
      return execution;
    },
  };
}

function successfulFetcher(body = ISSUE_BODY_WITH_ADR): ReviewerIssueFetcher {
  return async () => Object.freeze({ body });
}

// --- production discovery: self-fetch real-entry tracers own ticket/ADR boundaries ---

// One end-to-end tracer for the self-fetch byte propagation seam
// (real dispatch entry → Spec material/prompt → receipt face).
// Absorbs typed-over-branch/commit priority + ADR first-appearance/dedupe boundaries.
test("production discovery: self-fetch bytes propagate from dispatch entry to receipt", async () => {
  const h = harness(pin, {
    ticketNumber: 176,
    featureTokens: ["fix/issue-99-other"],
    commitMessages: ["feat: land #12"],
    origin: { owner: "Acme", repo: "widgets" },
    pinnedTexts: {
      "docs/adr/0001-roles-grow-by-demand.md": "# ADR 0001\nbody\n",
    },
    fetchIssue: successfulFetcher(),
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards", "spec"]);
  const fetched = result.dispatch.specFetchedMaterial;
  assert.ok(fetched);
  assert.equal(fetched!.adopted.source, "typed-ticket-number");
  assert.equal(fetched!.ticketNumber, 176);
  assert.deepEqual(fetched!.abandoned, [
    { source: "branch-token", ticketNumber: 99 },
    { source: "commit-message", ticketNumber: 12 },
  ]);
  assert.equal(fetched!.issueBody, ISSUE_BODY_WITH_ADR);
  assert.deepEqual(
    fetched!.adrs.map((a) => ({ path: a.path, status: a.status })),
    [
      { path: "docs/adr/0001-roles-grow-by-demand.md", status: "present" },
      { path: "docs/adr/missing-adr.md", status: "missing" },
    ],
  );
  const specPrompt = result.dispatch.legs.find((leg) => leg.axis === "spec")!.prompt;
  assert.equal(specPrompt.includes(reviewerFetchedSpecMaterial(fetched!)), true);
  assert.equal(specPrompt.includes(ISSUE_BODY_WITH_ADR), true);
  assert.equal(specPrompt.includes("source: typed-ticket-number"), true);
  assert.equal(
    result.dispatch.legs.find((leg) => leg.axis === "standards")?.prompt.includes(
      "Authority-Fetched-Spec:",
    ),
    false,
  );

  const { assembleRuntimeReviewerReceipt } = await import("../../src/reviewer-settlement.ts");
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assembled = assembleRuntimeReviewerReceipt({
    intent: { status: "completed" },
    canonicalSkillText: "review skill",
    record: {
      rejections: [],
      accepted: {
        identity: result.dispatch.identity,
        recipe: result.dispatch.recipe,
        input: result.dispatch.input,
        target: result.dispatch.targetSnapshot,
        range: result.dispatch.range,
        authorityRefs: result.dispatch.authorityRefs,
        specDisposition: result.dispatch.specDisposition,
        ...(result.dispatch.specFetchedMaterial === undefined
          ? {}
          : { specFetchedMaterial: result.dispatch.specFetchedMaterial }),
        legs: result.dispatch.legs,
      },
      started: { dispatchIdentity: result.dispatch.identity, cardinality: 2 },
      results: {
        standards: {
          dispatchIdentity: result.dispatch.identity,
          axis: "standards",
          status: "successful",
          prompt: result.dispatch.legs[0]!.prompt,
          target: pin,
          workspaceDisposition: "deleted",
          report: "Standards finding count: 0.",
          usage: zeroUsage,
        },
        spec: {
          dispatchIdentity: result.dispatch.identity,
          axis: "spec",
          status: "successful",
          prompt: result.dispatch.legs[1]!.prompt,
          target: pin,
          workspaceDisposition: "deleted",
          report: "Spec ok.",
          usage: zeroUsage,
        },
      },
    },
  });
  assert.equal(assembled.specFetchedMaterial?.issueBody, ISSUE_BODY_WITH_ADR);
  assert.equal(assembled.specFetchedMaterial?.adopted.source, "typed-ticket-number");
  assert.equal(assembled.specFetchedMaterial?.ticketNumber, 176);
  assert.deepEqual(assembled.specFetchedMaterial?.abandoned, [
    { source: "branch-token", ticketNumber: 99 },
    { source: "commit-message", ticketNumber: 12 },
  ]);
});

test("production discovery: branch token self-fetch launches Spec", async () => {
  const h = harness(pin, {
    featureTokens: ["fix/issue-343-spec-fetch"],
    // Commit candidate present but lower priority — abandoned, not adopted.
    commitMessages: ["chore: polish #99"],
    origin: { owner: "Acme", repo: "widgets" },
    fetchIssue: successfulFetcher("branch-sourced body bytes"),
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.equal(result.dispatch.specFetchedMaterial?.adopted.source, "branch-token");
  assert.equal(result.dispatch.specFetchedMaterial?.ticketNumber, 343);
  assert.deepEqual(result.dispatch.specFetchedMaterial?.abandoned, [
    { source: "commit-message", ticketNumber: 99 },
  ]);
  assert.equal(result.dispatch.specFetchedMaterial?.issueBody, "branch-sourced body bytes");
  assert.equal(
    result.dispatch.authorityRefs[0],
    "https://github.com/Acme/widgets/issues/343",
  );
});

test("production discovery: commit message #N self-fetch launches Spec", async () => {
  const h = harness(pin, {
    featureTokens: [],
    // Newest subject only: first #N wins; older commits are not scanned.
    commitMessages: ["fix: land #88 and mention #7", "older #1"],
    origin: { owner: "Acme", repo: "widgets" },
    fetchIssue: successfulFetcher("commit-sourced body"),
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.equal(result.dispatch.specFetchedMaterial?.adopted.source, "commit-message");
  assert.equal(result.dispatch.specFetchedMaterial?.ticketNumber, 88);
  assert.deepEqual(result.dispatch.specFetchedMaterial?.abandoned, []);
  assert.equal(result.dispatch.specFetchedMaterial?.issueBody, "commit-sourced body");
});

// --- degradation chain ---

test("production discovery: tracker unreachable degrades to authorityRefs", async () => {
  const refs = Object.freeze(["https://example.com/spec"]);
  const h = harness(pin, {
    ticketNumber: 50,
    origin: { owner: "Acme", repo: "widgets" },
    authorityRefs: refs,
    fetchIssue: async () => undefined,
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.deepEqual(result.dispatch.authorityRefs, [...refs]);
  assert.equal(result.dispatch.specFetchedMaterial, undefined);
  assert.equal(
    result.dispatch.legs.find((leg) => leg.axis === "spec")?.prompt.includes(
      reviewerAuthorityRefsMaterial(refs),
    ),
    true,
  );
});

test("production discovery: no origin degrades to local path match", async () => {
  const h = harness(pin, {
    ticketNumber: 50,
    origin: "absent",
    featureTokens: ["feat/login"],
    specCandidatePaths: ["docs/login.md"],
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.deepEqual(result.dispatch.authorityRefs, ["docs/login.md"]);
  assert.equal(result.dispatch.specFetchedMaterial, undefined);
});

test("production discovery: self-fetch fail then no refs/local yields skipped-missing", async () => {
  const h = harness(pin, {
    ticketNumber: 50,
    origin: { owner: "Acme", repo: "widgets" },
    featureTokens: [],
    fetchIssue: async () => undefined,
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "skipped-missing");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards"]);
});

test("production discovery: authorityRefs preferred over local when self-fetch unavailable", async () => {
  const refs = Object.freeze(["https://example.com/explicit"]);
  const h = harness(pin, {
    // no ticket sources
    featureTokens: ["feat/login"],
    specCandidatePaths: ["docs/login.md"],
    authorityRefs: refs,
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.deepEqual(result.dispatch.authorityRefs, [...refs]);
  assert.equal(result.dispatch.specFetchedMaterial, undefined);
});

// --- negative: prompt is never Spec material ---

test("production discovery: no ticket/refs/local skips Spec (prompt never material)", async () => {
  // No supplied refs, no matchable feature tokens, no ticket sources ⇒ missing.
  // Caller prompt/admitted request is not an input to discovery at all.
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

test("production discovery: pinned-target paths match after stripping feat/feature shells", async () => {
  const h = harness(pin, {
    featureTokens: ["feat/login", "feature/checkout"],
    specCandidatePaths: ["docs/login.md", "specs/checkout.md"],
  });
  const result = await h.dispatcher.dispatch("main~1");
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.dispatch.specDisposition, "launched");
  assert.deepEqual(result.dispatch.legs.map((leg) => leg.axis), ["standards", "spec"]);
  assert.deepEqual(result.dispatch.authorityRefs, ["docs/login.md", "specs/checkout.md"]);
});

test("production discovery: non-absence Git/I-O failure does not become missing", async () => {
  const ioFailure = new Error("git ls-tree permission denied");
  const h = harness(pin, {
    featureTokens: ["feature-login"],
    listSpecError: ioFailure,
  });
  await assert.rejects(
    () => h.dispatcher.dispatch("main~1"),
    (error: unknown) => error === ioFailure,
  );
  assert.equal(h.execution, undefined);
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
