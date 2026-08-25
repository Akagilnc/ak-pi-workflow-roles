import assert from "node:assert/strict";
import test from "node:test";
import * as reviewerContracts from "../../src/package-contracts/reviewer-output.ts";
import { projectReviewerIntentToReceipt, REVIEWER_OUTPUT_TOOL_NAME, validateReviewerIntent, validateRuntimeReviewerReceipt, type ReviewerIntent } from "../../src/package-contracts/reviewer-output.ts";
// @ts-expect-error ReviewerOutput was a compatibility alias and is intentionally absent.
import type { ReviewerOutput } from "../../src/package-contracts/reviewer-output.ts";
import { extractReviewerRoleOutcome } from "../../src/public-cli/settlement.ts";
import { assembleRuntimeReviewerReceipt } from "../../src/reviewer-settlement.ts";

const prompt = (axis: string) => ({ text: `${axis} prompt\n` });
function receipt(axes: readonly ("standards" | "spec")[] = ["standards"], status: "completed" | "refused" = "completed") {
  const skillText = "skill\n";
  const reports = Object.fromEntries(axes.map(axis => [axis, { text: `${axis} report` }]));
  const outcomes = Object.fromEntries(axes.map(axis => [axis, { status: "successful", prompt: prompt(axis), workspaceDisposition: "deleted" }]));
  return {
    version: 2,
    status,
    ...(status === "refused" ? { diagnostic: "stopped" } : {}),
    acceptedBatch: { identity: "dispatch", legs: axes.map(axis => ({ axis, prompt: prompt(axis) })) },
    reports,
    outcomes,
    identities: {
      canonicalSkill: { text: skillText },
      construction: { recipe: "reviewer-common-bundle-v1" },
      target: {
        repositoryRoot: "/repo",
        objectFormat: "sha1",
        targetHead: "a".repeat(40),
        refs: { tag: { objectId: "b".repeat(40), peeledCommitId: null } },
      },
    },
  };
}

test("Reviewer intent and receipt leaves remain distinct without legacy runtime exports", () => {
  const completed: ReviewerIntent = validateReviewerIntent({ status: "completed" });
  const refused: ReviewerIntent = validateReviewerIntent({ status: "refused", diagnostic: "stopped" });
  assert.equal(projectReviewerIntentToReceipt(completed, receipt()).version, 2);
  assert.equal(projectReviewerIntentToReceipt(refused, receipt(["standards"], "refused")).diagnostic, "stopped");
  assert.equal("validateAcceptedReviewerDetails" in reviewerContracts, false);
});

test("Reviewer target IDs are bound to the accepted object format", () => {
  const value = receipt() as any;
  value.identities.target.objectFormat = "sha256";
  assert.throws(() => validateRuntimeReviewerReceipt(value));
  value.identities.target.targetHead = "a".repeat(64);
  value.identities.target.refs.tag.objectId = "b".repeat(64);
  validateRuntimeReviewerReceipt(value);
});

test("settlement preserves ledgered plain-text outcomes without materialization shells", () => {
  const source = receipt(["standards", "spec"], "refused") as any;
  source.outcomes.spec.status = "failed"; source.outcomes.spec.failure = "child"; source.outcomes.spec.diagnostic = "child diagnostic"; delete source.reports.spec;
  const results = Object.fromEntries(["standards", "spec"].map(axis => [axis, {
    dispatchIdentity: "dispatch",
    axis,
    status: source.outcomes[axis].status,
    prompt: source.outcomes[axis].prompt.text,
    workspaceDisposition: source.outcomes[axis].workspaceDisposition,
    target: source.identities.target,
    ...(axis === "standards"
      ? { report: source.reports.standards.text, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      : { failure: source.outcomes[axis].failure, diagnostic: source.outcomes[axis].diagnostic }),
  }]));
  const assembled = assembleRuntimeReviewerReceipt({
    intent: { status: "refused", diagnostic: "stopped" },
    canonicalSkillText: source.identities.canonicalSkill.text,
    record: {
      rejections: [],
      results,
      accepted: {
        identity: "dispatch",
        input: { canonicalSkill: source.identities.canonicalSkill.text, task: "task", construction: { recipeId: "reviewer-common-bundle" } },
        legs: source.acceptedBatch.legs.map((leg: any) => ({ axis: leg.axis, prompt: leg.prompt.text })),
        recipe: source.identities.construction.recipe,
        target: source.identities.target,
      },
    } as any,
  });
  assert.equal(assembled.outcomes.standards?.status, "successful");
  assert.equal(assembled.outcomes.spec?.status, "failed");
  assert.deepEqual(assembled.identities.canonicalSkill, { text: source.identities.canonicalSkill.text });
  assert.deepEqual(assembled.reports.standards, { text: "standards report" });
  assert.equal("runtimeConstructionEvidence" in (assembled.outcomes.standards ?? {}), false);
  validateRuntimeReviewerReceipt(assembled);
});

test("accepted projection authenticates exact canonical terminal leg and report coverage", () => {
  validateRuntimeReviewerReceipt(receipt(["standards"])); validateRuntimeReviewerReceipt(receipt(["standards", "spec"]));
  const mixed = receipt(["standards", "spec"], "refused") as any; mixed.outcomes.spec = { ...mixed.outcomes.spec, status: "failed", failure: "child", diagnostic: "child diagnostic" }; delete mixed.reports.spec; validateRuntimeReviewerReceipt(mixed);
  for (const mutate of [
    (r:any) => delete r.outcomes.spec,
    (r:any) => r.outcomes.spec.prompt = prompt("wrong"),
    (r:any) => r.acceptedBatch.legs.reverse(),
    (r:any) => delete r.reports.spec,
  ]) { const value = receipt(["standards", "spec"]) as any; mutate(value); assert.throws(() => validateRuntimeReviewerReceipt(value)); }
  const pre = receipt([], "refused") as any; delete pre.acceptedBatch; delete pre.identities.construction; delete pre.identities.target; validateRuntimeReviewerReceipt(pre);
  pre.reports.standards = { text: "x" }; validateRuntimeReviewerReceipt(pre);
  const withPresentation = receipt(["standards"]) as any;
  withPresentation.reports.standards = { text: "standards report", utf8Length: 999, sha256: "deadbeef" };
  withPresentation.outcomes.extra = withPresentation.outcomes.standards;
  validateRuntimeReviewerReceipt(withPresentation);
});

test("accepted projection binds specDisposition once to accepted-leg axes", () => {
  const launched = receipt(["standards", "spec"]) as any;
  launched.specDisposition = "launched";
  validateRuntimeReviewerReceipt(launched);

  const skipped = receipt(["standards"]) as any;
  skipped.specDisposition = "skipped-missing";
  validateRuntimeReviewerReceipt(skipped);

  // Shortest contradiction negatives: disposition disagrees with accepted legs.
  const launchedStandardsOnly = receipt(["standards"]) as any;
  launchedStandardsOnly.specDisposition = "launched";
  assert.throws(
    () => validateRuntimeReviewerReceipt(launchedStandardsOnly),
    /specDisposition launched requires Standards\+Spec/,
  );

  const skippedWithSpec = receipt(["standards", "spec"]) as any;
  skippedWithSpec.specDisposition = "skipped-missing";
  assert.throws(
    () => validateRuntimeReviewerReceipt(skippedWithSpec),
    /specDisposition skipped-missing requires Standards-only/,
  );
});

test("Reviewer projections safely ignore unrecognizable shape", () => {
  for (const value of [undefined, null, 1, "receipt", new Proxy({}, { get() { throw new Error("getter"); } })]) {
    assert.doesNotThrow(() => validateRuntimeReviewerReceipt(value));
    assert.throws(() => validateReviewerIntent(value), /recognized execution intent/);
  }
  assert.deepEqual(validateReviewerIntent({ status: "completed", presentation: true }), { status: "completed" });
  assert.deepEqual(validateReviewerIntent({ status: "refused" }), { status: "refused", diagnostic: undefined });
});

/** Ledger-backed two-axis child reports — shared tracer for seat amendments. */
function twoAxisRecord(source: any) {
  const results = Object.fromEntries(("standards,spec".split(",") as ("standards" | "spec")[]).map(axis => [axis, {
    dispatchIdentity: "dispatch",
    axis,
    status: "successful" as const,
    prompt: source.outcomes[axis].prompt.text,
    workspaceDisposition: source.outcomes[axis].workspaceDisposition,
    target: source.identities.target,
    report: source.reports[axis].text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }]));
  return {
    rejections: [],
    results,
    accepted: {
      identity: "dispatch",
      input: { canonicalSkill: source.identities.canonicalSkill.text, task: "task", construction: { recipeId: "reviewer-common-bundle" } },
      legs: source.acceptedBatch.legs.map((leg: { axis: "standards" | "spec"; prompt: { text: string } }) => ({ axis: leg.axis, prompt: leg.prompt.text })),
      recipe: source.identities.construction.recipe,
      target: source.identities.target,
    },
  } as any;
}

function assembleFromSubmission(parameters: unknown) {
  const intent = validateReviewerIntent(parameters);
  const source = receipt(["standards", "spec"]) as any;
  const standardsText = source.reports.standards.text as string;
  const specText = source.reports.spec.text as string;
  const assembled = assembleRuntimeReviewerReceipt({
    intent,
    canonicalSkillText: source.identities.canonicalSkill.text,
    record: twoAxisRecord(source),
  });
  return { intent, assembled, standardsText, specText };
}

test("parent axis amendment survives assembly without rewriting child reports", () => {
  // Unit seam only: intent → assembler → decisive-facts projection.
  // Real A→auditor revise→B→pass lives on the package lifecycle tracer.
  const delta = Object.freeze({ standards: "axis-delta-A" });
  const { assembled, standardsText, specText } = assembleFromSubmission({
    status: "completed",
    amendments: delta,
    unknownExtra: true,
  });

  assert.deepEqual(assembled.amendments, delta);
  assert.equal(assembled.reports.standards?.text, standardsText);
  assert.equal(assembled.reports.spec?.text, specText);
  // No second full aggregate report — only the seat-owned delta slot.
  assert.equal("aggregate" in assembled, false);
  assert.equal("report" in assembled, false);
  validateRuntimeReviewerReceipt(assembled);
  // Public decisive facts: typed amendment axis presence only — no prose copy.
  const extracted = extractReviewerRoleOutcome([
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: REVIEWER_OUTPUT_TOOL_NAME,
        content: [{ type: "text", text: "Reviewer report accepted" }],
        details: assembled,
        isError: false,
      },
    } as any,
  ]);
  assert.deepEqual(extracted?.outcome.decisiveFacts.amendmentAxes, ["standards"]);
  assert.equal("amendments" in (extracted?.outcome.decisiveFacts ?? {}), false);

  // Missing amendments and unknown extras never reject; only typed presence is retained.
  const bare = assembleFromSubmission({ status: "completed", presentation: true });
  assert.equal("amendments" in bare.assembled, false);
  assert.deepEqual(bare.intent, { status: "completed" });
  const emptySlots = assembleFromSubmission({ status: "completed", amendments: { other: 1 } });
  assert.equal("amendments" in emptySlots.assembled, false);
  assert.doesNotThrow(() => validateReviewerIntent({ status: "completed", amendments: "not-an-object" }));
});
