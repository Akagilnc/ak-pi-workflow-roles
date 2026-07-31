/** Package-owned Reviewer intent and runtime-receipt leaves — no role registration surface. */

import type { ReviewerAcceptedEvidence, ReviewerFailureClassification, ReviewerWorkspaceDisposition } from "../reviewer-execution-ledger.ts";
import { isReviewerPromptIdentity, sameReviewerPromptIdentity, type ReviewerPromptIdentity } from "../reviewer-prompt-identity.ts";
import { sha256Hex } from "../sha256.ts";
import { verifyBundleIdentity } from "../reviewer-construction.ts";

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "Reviewer report accepted";

export type ReviewerIntent =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "refused"; diagnostic: string }>;
export type VerbatimChildReport = Readonly<{ text: string; utf8Length: number; sha256: string }>;
export type RuntimeReviewerOutcome = Readonly<{
  status: "successful" | "failed";
  prompt: ReviewerPromptIdentity;
  workspaceDisposition: ReviewerWorkspaceDisposition;
  failure?: ReviewerFailureClassification;
}>;
export type RuntimeReviewerAcceptedBatch = Readonly<{
  identity: string;
  legs: readonly Readonly<{ axis: "standards" | "spec"; prompt: ReviewerPromptIdentity }>[];
}>;
export type RuntimeReviewerReceiptV2 = Readonly<{
  version: 2;
  status: "completed" | "refused";
  diagnostic?: string;
  acceptedBatch?: RuntimeReviewerAcceptedBatch;
  reports: Readonly<Partial<Record<"standards" | "spec", VerbatimChildReport>>>;
  outcomes: Readonly<Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>>>;
  identities: Readonly<{
    canonicalSkill: Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: ReviewerPromptIdentity }>;
    construction?: Readonly<Pick<ReviewerAcceptedEvidence, "recipe" | "bundle">>;
    target?: ReviewerAcceptedEvidence["target"];
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function validWorkspace(value: unknown): boolean {
  return value === "deleted" || value === "not-created" || (isRecord(value) && exactKeys(value, ["retained"]) && typeof value.retained === "string" && value.retained.length > 0);
}
const failures = new Set(["cancelled", "provider", "snapshot", "workspace", "child", "unknown"]);

export function validateReviewerIntent(output: unknown): ReviewerIntent {
  if (!isRecord(output)) throw new Error("Reviewer output must be a completed or refused intent");
  if (output.status === "completed" && exactKeys(output, ["status"])) return { status: "completed" };
  if (output.status === "refused" && exactKeys(output, ["status", "diagnostic"]) && typeof output.diagnostic === "string" && output.diagnostic.trim().length > 0) {
    return { status: "refused", diagnostic: output.diagnostic };
  }
  throw new Error("Reviewer completed intent has no report; refused requires only a separate non-blank diagnostic");
}

/** Validate the runtime-owned V2 receipt, including all byte identities and outcome/report laws. */
export function validateRuntimeReviewerReceipt(output: unknown): RuntimeReviewerReceiptV2 {
  if (!isRecord(output) || !exactKeys(output, ["version", "status", "reports", "outcomes", "identities"], ["diagnostic", "acceptedBatch"]) || output.version !== 2 ||
      (output.status !== "completed" && output.status !== "refused") || !isRecord(output.reports) || !isRecord(output.outcomes) || !isRecord(output.identities)) throw new Error("Invalid Reviewer V2 receipt");
  if (output.status === "completed" ? Object.hasOwn(output, "diagnostic") : typeof output.diagnostic !== "string" || output.diagnostic.trim().length === 0) throw new Error("Reviewer receipt diagnostic disagrees with status");
  if (!exactKeys(output.reports, [], ["standards", "spec"]) || !exactKeys(output.outcomes, [], ["standards", "spec"]) ||
      !exactKeys(output.identities, ["canonicalSkill"], ["construction", "target"])) throw new Error("Invalid Reviewer receipt projection keys");
  const skill = output.identities.canonicalSkill;
  if (!isRecord(skill) || !exactKeys(skill, ["sha256", "utf8Length", "snapshotIdentity"]) || !isRecord(skill.snapshotIdentity) ||
      !exactKeys(skill.snapshotIdentity, ["text", "utf8Length", "sha256"]) || !isReviewerPromptIdentity(skill.snapshotIdentity as ReviewerPromptIdentity) ||
      skill.sha256 !== skill.snapshotIdentity.sha256 || skill.utf8Length !== skill.snapshotIdentity.utf8Length) throw new Error("Invalid canonical Skill content identity");
  const hasBatch = Object.hasOwn(output, "acceptedBatch");
  if (hasBatch !== Object.hasOwn(output.identities, "construction") || hasBatch !== Object.hasOwn(output.identities, "target") ||
      (hasBatch && (!isRecord(output.acceptedBatch) || !isRecord(output.identities.construction) || !isRecord(output.identities.target)))) throw new Error("Incomplete Reviewer accepted-batch identity");
  let expectedLegs: readonly Record<string, unknown>[] = [];
  if (hasBatch) {
    const acceptedBatch = output.acceptedBatch as Record<string, unknown>;
    const construction = output.identities.construction as Record<string, unknown>;
    const target = output.identities.target as Record<string, unknown>;
    if (!exactKeys(acceptedBatch, ["identity", "legs"]) || typeof acceptedBatch.identity !== "string" || acceptedBatch.identity.length === 0 || !Array.isArray(acceptedBatch.legs) ||
        (acceptedBatch.legs.length !== 1 && acceptedBatch.legs.length !== 2)) throw new Error("Invalid Reviewer accepted-batch projection");
    expectedLegs = acceptedBatch.legs as Record<string, unknown>[];
    const expectedAxes = expectedLegs.map((leg) => leg.axis);
    if (expectedAxes[0] !== "standards" || (expectedAxes.length === 2 && expectedAxes[1] !== "spec") || expectedLegs.some((leg) =>
      !isRecord(leg) || !exactKeys(leg, ["axis", "prompt"]) || !isRecord(leg.prompt) || !exactKeys(leg.prompt, ["text", "utf8Length", "sha256"]) || !isReviewerPromptIdentity(leg.prompt as ReviewerPromptIdentity)))
      throw new Error("Invalid Reviewer accepted-leg projection");
    const objectId = (value: unknown): boolean => typeof value === "string" && new RegExp(target.objectFormat === "sha1" ? "^[0-9a-f]{40}$" : "^[0-9a-f]{64}$").test(value);
    if (!exactKeys(construction, ["recipe", "bundle"]) || construction.recipe !== "reviewer-common-bundle-v1" || !isRecord(construction.bundle) || !verifyBundleIdentity(construction.bundle as any) ||
        !exactKeys(target, ["repositoryRoot", "objectFormat", "targetHead", "refs"]) || typeof target.repositoryRoot !== "string" || target.repositoryRoot.length === 0 ||
        (target.objectFormat !== "sha1" && target.objectFormat !== "sha256") || !objectId(target.targetHead) || !isRecord(target.refs) ||
        Object.values(target.refs).some((ref) => !isRecord(ref) || !exactKeys(ref, ["objectId", "peeledCommitId"]) || !objectId(ref.objectId) || (ref.peeledCommitId !== null && !objectId(ref.peeledCommitId)))) throw new Error("Invalid Reviewer construction or target identity");
  }
  for (const axis of ["standards", "spec"] as const) {
    const report = output.reports[axis];
    const outcome = output.outcomes[axis];
    if (report !== undefined && (!isRecord(report) || !exactKeys(report, ["text", "utf8Length", "sha256"]) || typeof report.text !== "string" ||
        report.utf8Length !== Buffer.byteLength(report.text, "utf8") || report.sha256 !== sha256Hex(report.text))) throw new Error("Invalid Reviewer report identity");
    if (outcome === undefined) { if (report !== undefined) throw new Error("Reviewer report lacks outcome"); continue; }
    if (!isRecord(outcome) || !exactKeys(outcome, ["status", "prompt", "workspaceDisposition"], ["failure"]) ||
        (outcome.status !== "successful" && outcome.status !== "failed") || !isRecord(outcome.prompt) || !exactKeys(outcome.prompt, ["text", "utf8Length", "sha256"]) ||
        !isReviewerPromptIdentity(outcome.prompt as ReviewerPromptIdentity) || !validWorkspace(outcome.workspaceDisposition)) throw new Error("Invalid Reviewer outcome");
    if (outcome.status === "successful") {
      if (Object.hasOwn(outcome, "failure") || report === undefined) throw new Error("Successful Reviewer outcome requires exactly one report");
    } else if (!failures.has(outcome.failure as string) || report !== undefined) throw new Error("Failed Reviewer outcome requires a classification and no report");
  }
  const expectedAxes = expectedLegs.map((leg) => leg.axis as "standards" | "spec");
  const outcomeAxes = Object.keys(output.outcomes);
  if (hasBatch && (outcomeAxes.length !== expectedAxes.length || outcomeAxes.some((axis, index) => axis !== expectedAxes[index]))) throw new Error("Reviewer outcomes must exactly cover accepted legs in canonical order");
  for (const [index, axis] of expectedAxes.entries()) {
    const outcome = output.outcomes[axis]! as RuntimeReviewerOutcome;
    if (!sameReviewerPromptIdentity(outcome.prompt, expectedLegs[index]!.prompt as ReviewerPromptIdentity)) throw new Error("Reviewer outcome prompt disagrees with accepted leg");
  }
  if (output.status === "completed" && (!hasBatch || Object.values(output.outcomes).some((item) => (item as RuntimeReviewerOutcome).status !== "successful"))) throw new Error("Completed Reviewer receipt requires a successful accepted batch");
  if (!hasBatch && (Object.keys(output.outcomes).length !== 0 || Object.keys(output.reports).length !== 0)) throw new Error("Pre-acceptance Reviewer refusal cannot contain outcomes or reports");
  return output as RuntimeReviewerReceiptV2;
}

/** Project thin submitted intent onto runtime enrichment without comparing runtime-owned fields. */
export function projectReviewerIntentToReceipt(intentValue: unknown, receiptValue: unknown): RuntimeReviewerReceiptV2 {
  const intent = validateReviewerIntent(intentValue);
  const receipt = validateRuntimeReviewerReceipt(receiptValue);
  if (receipt.status !== intent.status || (intent.status === "completed" ? receipt.diagnostic !== undefined : receipt.diagnostic !== intent.diagnostic)) {
    throw new Error("Reviewer intent and runtime receipt disagree");
  }
  return receipt;
}
