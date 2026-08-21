/** Package-owned Reviewer intent and runtime-receipt leaves — no role registration surface. */

import { seatFallbackBaseStatus } from "../engine-labor-fallback.ts";
import type { ReviewerAcceptedEvidence, ReviewerFailureClassification, ReviewerWorkspaceDisposition } from "../reviewer-execution-ledger.ts";

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "Reviewer report accepted";

export type ReviewerIntent =
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "refused"; diagnostic: string }>;
/** Child report is plain text — no length/digest identity shell (ADR 0031). */
export type VerbatimChildReport = Readonly<{ text: string }>;
/** Prompt projection on the receipt face is plain text (ADR 0031). */
export type ReviewerReceiptPrompt = Readonly<{ text: string }>;
/** Canonical Skill content on the receipt face is plain text (ADR 0031/0032). */
export type ReviewerReceiptSkillContent = Readonly<{ text: string }>;
type RuntimeReviewerOutcomeCommon = Readonly<{
  prompt: ReviewerReceiptPrompt;
  workspaceDisposition: ReviewerWorkspaceDisposition;
}>;
export type RuntimeReviewerOutcome = RuntimeReviewerOutcomeCommon & (
  | Readonly<{ status: "successful"; failure?: never }>
  | Readonly<{ status: "failed"; failure: ReviewerFailureClassification; diagnostic: string }>
);
export type RuntimeReviewerAcceptedBatch = Readonly<{
  identity: string;
  legs: readonly Readonly<{ axis: "standards" | "spec"; prompt: ReviewerReceiptPrompt }>[];
}>;
/** Honest Spec-child disposition on the receipt face. */
export type RuntimeReviewerSpecDisposition = "launched" | "skipped-missing";
export type RuntimeReviewerReceiptV2 = Readonly<{
  version: 2;
  status: "completed" | "refused";
  diagnostic?: string;
  acceptedBatch?: RuntimeReviewerAcceptedBatch;
  /** Present on accepted batches: launched Spec child, or skipped after confirmed missing Spec. */
  specDisposition?: RuntimeReviewerSpecDisposition;
  /** Self-fetch bytes + source annotation when Spec primary path produced material (#343). */
  specFetchedMaterial?: ReviewerAcceptedEvidence["specFetchedMaterial"];
  reports: Readonly<Partial<Record<"standards" | "spec", VerbatimChildReport>>>;
  outcomes: Readonly<Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>>>;
  identities: Readonly<{
    canonicalSkill: ReviewerReceiptSkillContent;
    construction?: Readonly<{ recipe: ReviewerAcceptedEvidence["recipe"] }>;
    target?: ReviewerAcceptedEvidence["target"];
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function read(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  try { return value[key]; } catch { return undefined; }
}

export function validateReviewerIntent(output: unknown): ReviewerIntent {
  const status = read(output, "status");
  if (status === "completed") return { status };
  if (status === "refused") return { status, diagnostic: read(output, "diagnostic") as string };
  throw new Error("Reviewer output has no recognized execution intent");
}

/** Validate runtime-owned facts at their real identity seams (target pins + plain text). */
export function validateRuntimeReviewerReceipt(output: unknown): RuntimeReviewerReceiptV2 {
  const acceptedBatch = read(output, "acceptedBatch");
  const identities = read(output, "identities");
  const construction = read(identities, "construction");
  const target = read(identities, "target");
  const reports = read(output, "reports");
  const outcomes = read(output, "outcomes");
  const legs = read(acceptedBatch, "legs");

  // A recognizable accepted batch must remain bound to its exact target pin.
  if (acceptedBatch !== undefined || construction !== undefined || target !== undefined) {
    if (!isRecord(acceptedBatch) || !isRecord(construction) || !isRecord(target) || !Array.isArray(legs))
      throw new Error("Incomplete Reviewer accepted-batch identity");
    const objectFormat = read(target, "objectFormat");
    const objectId = (value: unknown): boolean => typeof value === "string" && new RegExp(objectFormat === "sha1" ? "^[0-9a-f]{40}$" : "^[0-9a-f]{64}$").test(value);
    const refs = read(target, "refs");
    const skillText = read(read(identities, "canonicalSkill"), "text");
    if (typeof skillText !== "string" ||
        read(construction, "recipe") !== "reviewer-common-bundle-v1" ||
        (objectFormat !== "sha1" && objectFormat !== "sha256") || !objectId(read(target, "targetHead")) || !isRecord(refs) ||
        Object.values(refs).some((ref) => !isRecord(ref) || !objectId(read(ref, "objectId")) || (read(ref, "peeledCommitId") !== null && !objectId(read(ref, "peeledCommitId")))))
      throw new Error("Invalid Reviewer construction or target identity");

    const expectedAxes = legs.map((leg) => read(leg, "axis"));
    if (expectedAxes[0] !== "standards" || (expectedAxes.length === 2 && expectedAxes[1] !== "spec") || expectedAxes.length < 1 || expectedAxes.length > 2)
      throw new Error("Invalid Reviewer accepted-leg projection");
    if (!isRecord(outcomes) || !isRecord(reports)) throw new Error("Accepted Reviewer batch lacks outcomes or reports");
    const outcomeAxes = Object.keys(outcomes).filter(axis => axis === "standards" || axis === "spec");
    if (outcomeAxes.length !== expectedAxes.length || outcomeAxes.some((axis, index) => axis !== expectedAxes[index]))
      throw new Error("Reviewer outcomes must exactly cover accepted legs in canonical order");

    for (const [index, axisValue] of expectedAxes.entries()) {
      const axis = axisValue as "standards" | "spec";
      const outcome = read(outcomes, axis);
      if (!isRecord(outcome)) throw new Error("Reviewer accepted leg lacks outcome");
      const expectedPrompt = read(read(legs[index], "prompt"), "text");
      const actualPrompt = read(read(outcome, "prompt"), "text");
      if (expectedPrompt !== actualPrompt) throw new Error("Reviewer outcome prompt disagrees with accepted leg");
      const status = read(outcome, "status");
      const report = read(reports, axis);
      if (status === "successful" && report === undefined)
        throw new Error("Successful Reviewer outcome lacks report");
      if (status === "failed" && report !== undefined) throw new Error("Failed Reviewer outcome cannot bind a report");
    }

    // One read inside the existing accepted-leg consistency cycle — not a second validator.
    // launched ⇔ Standards+Spec; skipped-missing ⇔ Standards only.
    const specDisposition = read(output, "specDisposition");
    if (specDisposition === "launched") {
      if (expectedAxes.length !== 2 || expectedAxes[0] !== "standards" || expectedAxes[1] !== "spec") {
        throw new Error("Reviewer specDisposition launched requires Standards+Spec accepted legs");
      }
    } else if (specDisposition === "skipped-missing") {
      if (expectedAxes.length !== 1 || expectedAxes[0] !== "standards") {
        throw new Error("Reviewer specDisposition skipped-missing requires Standards-only accepted legs");
      }
    } else if (specDisposition !== undefined) {
      throw new Error("Invalid Reviewer specDisposition");
    }
  }
  return output as RuntimeReviewerReceiptV2;
}

/** Project thin submitted intent onto runtime enrichment without comparing runtime-owned fields. */
export function projectReviewerIntentToReceipt(intentValue: unknown, receiptValue: unknown): RuntimeReviewerReceiptV2 {
  const intent = validateReviewerIntent(intentValue);
  const receipt = validateRuntimeReviewerReceipt(receiptValue);
  const receiptBase = seatFallbackBaseStatus(receipt.status);
  if (receiptBase !== intent.status || (intent.status === "completed" ? receipt.diagnostic !== undefined : receipt.diagnostic !== intent.diagnostic)) {
    throw new Error("Reviewer intent and runtime receipt disagree");
  }
  return receipt;
}
