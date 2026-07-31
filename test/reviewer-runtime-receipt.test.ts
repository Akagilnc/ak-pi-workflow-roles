import assert from "node:assert/strict";
import test from "node:test";
import { compileMechanicalBundle } from "../src/reviewer-construction.ts";
import * as reviewerContracts from "../src/package-contracts/reviewer-output.ts";
import { projectReviewerIntentToReceipt, validateReviewerIntent, validateRuntimeReviewerReceipt, type ReviewerIntent } from "../src/package-contracts/reviewer-output.ts";
// @ts-expect-error ReviewerOutput was a compatibility alias and is intentionally absent.
import type { ReviewerOutput } from "../src/package-contracts/reviewer-output.ts";
import { reviewerPromptIdentity } from "../src/reviewer-prompt-identity.ts";
import { assembleRuntimeReviewerReceipt } from "../src/reviewer-settlement.ts";
import { sha256Hex } from "../src/sha256.ts";

const prompt = (axis: string) => reviewerPromptIdentity(`${axis} prompt\n`);
function receipt(axes: readonly ("standards" | "spec")[] = ["standards"], status: "completed" | "refused" = "completed") {
  const skill = reviewerPromptIdentity("skill\n");
  const bundle = compileMechanicalBundle({ canonicalSkill: skill.text, task: "task", range: { base: "a", target: "b", diffCommand: "git diff a...b", diffSha256: "1".repeat(64), commits: ["b"] }, materials: [] }).bundle;
  const reports = Object.fromEntries(axes.map(axis => [axis, { text: `${axis} report`, utf8Length: Buffer.byteLength(`${axis} report`), sha256: sha256Hex(`${axis} report`) }]));
  const outcomes = Object.fromEntries(axes.map(axis => [axis, { status: "successful", prompt: prompt(axis), workspaceDisposition: "deleted", runtimeConstructionEvidence: { leg: axis, workspaceIdentity: `${axis}-workspace`, manifestSha256: bundle.manifestSha256, entries: bundle.entries.map(({ id, relativeClonePath, utf8Length, sha256 }) => ({ id, relativeClonePath, utf8Length, sha256, verified: true })) } }]));
  return { version: 2, status, ...(status === "refused" ? { diagnostic: "stopped" } : {}), acceptedBatch: { identity: "dispatch", legs: axes.map(axis => ({ axis, prompt: prompt(axis) })) }, reports, outcomes, identities: { canonicalSkill: { sha256: skill.sha256, utf8Length: skill.utf8Length, snapshotIdentity: skill }, construction: { recipe: "reviewer-common-bundle-v1", bundle }, target: { repositoryRoot: "/repo", objectFormat: "sha1", targetHead: "a".repeat(40), refs: { tag: { objectId: "b".repeat(40), peeledCommitId: null } } } } };
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
  source.outcomes.spec.status = "failed"; source.outcomes.spec.failure = "child"; delete source.reports.spec;
  const results = Object.fromEntries(["standards", "spec"].map(axis => [axis, {
    dispatchIdentity: "dispatch", axis, ...source.outcomes[axis], target: source.identities.target,
    ...(axis === "standards" ? { report: source.reports.standards.text } : {}),
  }]));
  const assembled = assembleRuntimeReviewerReceipt({
    intent: { status: "refused", diagnostic: "stopped" }, canonicalSkillSnapshotIdentity: source.identities.canonicalSkill.snapshotIdentity,
    record: { transportRejections: [], rejections: [], results, accepted: { identity: "dispatch", input: { canonicalSkill: source.identities.canonicalSkill }, legs: source.acceptedBatch.legs, recipe: source.identities.construction.recipe, bundle: source.identities.construction.bundle, target: source.identities.target } } as any,
  });
  assert.deepEqual(assembled.outcomes.standards?.runtimeConstructionEvidence, source.outcomes.standards.runtimeConstructionEvidence);
  assert.deepEqual(assembled.outcomes.spec?.runtimeConstructionEvidence, source.outcomes.spec.runtimeConstructionEvidence);
  validateRuntimeReviewerReceipt(assembled);
});

test("accepted projection authenticates exact canonical terminal leg and report coverage", () => {
  validateRuntimeReviewerReceipt(receipt(["standards"])); validateRuntimeReviewerReceipt(receipt(["standards", "spec"]));
  const mixed = receipt(["standards", "spec"], "refused") as any; mixed.outcomes.spec = { ...mixed.outcomes.spec, status: "failed", failure: "child" }; delete mixed.reports.spec; validateRuntimeReviewerReceipt(mixed);
  const mismatchedEvidence = receipt(["standards", "spec"]) as any; mismatchedEvidence.outcomes.spec.runtimeConstructionEvidence.leg = "standards"; assert.throws(() => validateRuntimeReviewerReceipt(mismatchedEvidence));
  for (const mutate of [
    (r:any) => delete r.outcomes.spec,
    (r:any) => r.outcomes.extra = r.outcomes.spec,
    (r:any) => r.outcomes.spec.prompt = prompt("wrong"),
    (r:any) => r.acceptedBatch.legs.reverse(),
    (r:any) => delete r.reports.spec,
    (r:any) => delete r.outcomes.spec.runtimeConstructionEvidence,
  ]) { const value = receipt(["standards", "spec"]) as any; mutate(value); assert.throws(() => validateRuntimeReviewerReceipt(value)); }
  const pre = receipt([], "refused") as any; delete pre.acceptedBatch; delete pre.identities.construction; delete pre.identities.target; validateRuntimeReviewerReceipt(pre);
  pre.reports.standards = { text: "x", utf8Length: 1, sha256: sha256Hex("x") }; assert.throws(() => validateRuntimeReviewerReceipt(pre));
});
