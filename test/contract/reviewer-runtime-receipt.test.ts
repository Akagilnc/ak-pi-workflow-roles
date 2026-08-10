import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileMechanicalBundle, projectMechanicalBundleIdentity } from "../../src/reviewer-construction.ts";
import * as reviewerContracts from "../../src/package-contracts/reviewer-output.ts";
import { projectReviewerIntentToReceipt, validateReviewerIntent, validateRuntimeReviewerReceipt, type ReviewerIntent } from "../../src/package-contracts/reviewer-output.ts";
// @ts-expect-error ReviewerOutput was a compatibility alias and is intentionally absent.
import type { ReviewerOutput } from "../../src/package-contracts/reviewer-output.ts";
import { assembleRuntimeReviewerReceipt } from "../../src/reviewer-settlement.ts";
import { materializeMechanicalBundle } from "../../src/reviewer-bundle-materializer.ts";
import { sha256Hex } from "../../src/sha256.ts";

const prompt = (axis: string) => ({ text: `${axis} prompt\n` });
function receipt(axes: readonly ("standards" | "spec")[] = ["standards"], status: "completed" | "refused" = "completed") {
  const skillText = "skill\n";
  const bundle = compileMechanicalBundle({ canonicalSkill: skillText, task: "task", range: { base: "a", target: "b", diffCommand: "git diff a...b", diffSha256: "1".repeat(64), commits: ["b"] } }).bundle;
  const reports = Object.fromEntries(axes.map(axis => [axis, { text: `${axis} report` }]));
  const outcomes = Object.fromEntries(axes.map(axis => [axis, { status: "successful", prompt: prompt(axis), workspaceDisposition: "deleted", runtimeConstructionEvidence: { leg: axis, workspaceIdentity: `${axis}-workspace`, manifestSha256: bundle.manifestSha256, entries: bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => ({ id, relativeClonePath, utf8Length, sha256, verified: true, readable: true })) } }]));
  return { version: 2, status, ...(status === "refused" ? { diagnostic: "stopped" } : {}), acceptedBatch: { identity: "dispatch", legs: axes.map(axis => ({ axis, prompt: prompt(axis) })) }, reports, outcomes, identities: { canonicalSkill: { text: skillText }, construction: { recipe: "reviewer-common-bundle-v1", bundle: projectMechanicalBundleIdentity(bundle) }, target: { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "a".repeat(40), refs: { tag: { objectId: "b".repeat(40), peeledCommitId: null } } } } };
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

test("settlement preserves ledgered materialization evidence for successful and later-failed legs", () => {
  const source = receipt(["standards", "spec"], "refused") as any;
  source.outcomes.spec.status = "failed"; source.outcomes.spec.failure = "child"; source.outcomes.spec.diagnostic = "child diagnostic"; delete source.reports.spec;
  const results = Object.fromEntries(["standards", "spec"].map(axis => [axis, {
    dispatchIdentity: "dispatch", axis, ...source.outcomes[axis], target: source.identities.target,
    ...(axis === "standards" ? { report: source.reports.standards.text } : {}),
  }]));
  const assembled = assembleRuntimeReviewerReceipt({
    intent: { status: "refused", diagnostic: "stopped" },
    canonicalSkillText: source.identities.canonicalSkill.text,
    record: {
      transportRejections: [],
      rejections: [],
      results,
      accepted: {
        identity: "dispatch",
        input: { canonicalSkill: { snapshotIdentity: { text: source.identities.canonicalSkill.text } } },
        legs: source.acceptedBatch.legs,
        recipe: source.identities.construction.recipe,
        bundle: source.identities.construction.bundle,
        target: source.identities.target,
      },
    } as any,
  });
  assert.deepEqual(assembled.outcomes.standards?.runtimeConstructionEvidence, source.outcomes.standards.runtimeConstructionEvidence);
  assert.deepEqual(assembled.outcomes.spec?.runtimeConstructionEvidence, source.outcomes.spec.runtimeConstructionEvidence);
  assert.deepEqual(assembled.identities.canonicalSkill, { text: source.identities.canonicalSkill.text });
  assert.deepEqual(assembled.reports.standards, { text: "standards report" });
  validateRuntimeReviewerReceipt(assembled);
});

test("actual materializer readback evidence is accepted by the terminal receipt consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-receipt-materializer-"));
  try {
    const value = receipt() as any;
    const materializerBundle = compileMechanicalBundle({ canonicalSkill: "skill\n", task: "task", range: { base: "a", target: "b", diffCommand: "git diff a...b", diffSha256: "1".repeat(64), commits: ["b"] } }).bundle;
    const evidence = await materializeMechanicalBundle(root, "standards", materializerBundle);
    value.outcomes.standards.runtimeConstructionEvidence = evidence;
    validateRuntimeReviewerReceipt(value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted projection authenticates exact canonical terminal leg and report coverage", () => {
  validateRuntimeReviewerReceipt(receipt(["standards"])); validateRuntimeReviewerReceipt(receipt(["standards", "spec"]));
  const mixed = receipt(["standards", "spec"], "refused") as any; mixed.outcomes.spec = { ...mixed.outcomes.spec, status: "failed", failure: "child", diagnostic: "child diagnostic" }; delete mixed.reports.spec; validateRuntimeReviewerReceipt(mixed);
  const mismatchedEvidence = receipt(["standards", "spec"]) as any; mismatchedEvidence.outcomes.spec.runtimeConstructionEvidence.leg = "standards"; assert.throws(() => validateRuntimeReviewerReceipt(mismatchedEvidence));
  const mismatchedSkill = receipt() as any; mismatchedSkill.identities.canonicalSkill.text = "different expansion\n"; assert.throws(() => validateRuntimeReviewerReceipt(mismatchedSkill));
  for (const mutate of [
    (r:any) => delete r.outcomes.spec,
    (r:any) => r.outcomes.spec.prompt = prompt("wrong"),
    (r:any) => r.acceptedBatch.legs.reverse(),
    (r:any) => delete r.reports.spec,
    (r:any) => delete r.outcomes.spec.runtimeConstructionEvidence,
  ]) { const value = receipt(["standards", "spec"]) as any; mutate(value); assert.throws(() => validateRuntimeReviewerReceipt(value)); }
  const pre = receipt([], "refused") as any; delete pre.acceptedBatch; delete pre.identities.construction; delete pre.identities.target; validateRuntimeReviewerReceipt(pre);
  pre.reports.standards = { text: "x" }; validateRuntimeReviewerReceipt(pre);
  const withPresentation = receipt(["standards"]) as any;
  withPresentation.reports.standards = { text: "standards report", utf8Length: 999, sha256: "deadbeef" };
  withPresentation.outcomes.extra = withPresentation.outcomes.standards;
  validateRuntimeReviewerReceipt(withPresentation);
});

test("Reviewer projections safely ignore unrecognizable shape", () => {
  for (const value of [undefined, null, 1, "receipt", new Proxy({}, { get() { throw new Error("getter"); } })]) {
    assert.doesNotThrow(() => validateRuntimeReviewerReceipt(value));
    assert.throws(() => validateReviewerIntent(value), /recognized execution intent/);
  }
  assert.deepEqual(validateReviewerIntent({ status: "completed", presentation: true }), { status: "completed" });
  assert.deepEqual(validateReviewerIntent({ status: "refused" }), { status: "refused", diagnostic: undefined });
});
