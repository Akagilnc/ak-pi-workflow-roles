/** Package-owned Reviewer intent and runtime-receipt leaves — no role registration surface. */

import type { ReviewerAcceptedEvidence, ReviewerFailureClassification, ReviewerWorkspaceDisposition } from "../reviewer-execution-ledger.ts";

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const REVIEWER_ACCEPTED_TEXT = "御史台回执已接受";

/** Seat-owned per-axis delta relative to child reports — not a replacement report. */
export type ReviewerAmendments = Readonly<Partial<Record<"standards" | "spec", string>>>;
export type ReviewerIntent =
  | Readonly<{ status: "completed"; amendments?: ReviewerAmendments }>
  | Readonly<{ status: "refused"; diagnostic: string; amendments?: ReviewerAmendments }>;
/** Child report body retained as delivered — no type/blank reshape (ADR 0031 / 0055 / #675). */
export type VerbatimChildReport = Readonly<{ text: unknown }>;
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
  /** Seat-owned per-axis deltas; separate from runtime-owned child reports. */
  amendments?: ReviewerAmendments;
  outcomes: Readonly<Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>>>;
  identities: Readonly<{
    canonicalSkill: ReviewerReceiptSkillContent;
    construction?: Readonly<{ recipe: ReviewerAcceptedEvidence["recipe"] }>;
    target?: ReviewerAcceptedEvidence["target"];
  }>;
}>;

export function validateReviewerIntent(output: unknown): ReviewerIntent {
  return output as ReviewerIntent;
}

/** Validate runtime-owned facts at their real identity seams (target pins + plain text). */
export function validateRuntimeReviewerReceipt(output: unknown): RuntimeReviewerReceiptV2 {
  return output as RuntimeReviewerReceiptV2;
}

/** Record-only: original receipt bytes, no second contract factory (#836 / ADR 0042). */
export function projectReviewerIntentToReceipt(_intentValue: unknown, receiptValue: unknown): RuntimeReviewerReceiptV2 {
  return receiptValue as RuntimeReviewerReceiptV2;
}
