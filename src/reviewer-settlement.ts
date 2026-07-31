import { sha256Hex } from "./sha256.ts";
import type { ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import type { ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";
import type { ReviewerIntent, RuntimeReviewerOutcome, RuntimeReviewerReceiptV2, VerbatimChildReport } from "./package-contracts/reviewer-output.ts";

export type { RuntimeReviewerOutcome, RuntimeReviewerReceiptV2, VerbatimChildReport } from "./package-contracts/reviewer-output.ts";

function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  if (value !== null && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)]))) as T;
  return value;
}

export function assembleRuntimeReviewerReceipt(input: {
  intent: ReviewerIntent;
  record: ReviewerExecutionRecord;
  canonicalSkillSnapshotIdentity: ReviewerPromptIdentity;
}): RuntimeReviewerReceiptV2 {
  const reports: Partial<Record<"standards" | "spec", VerbatimChildReport>> = {};
  const outcomes: Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>> = {};
  for (const axis of ["standards", "spec"] as const) {
    const result = input.record.results[axis];
    if (result === undefined) continue;
    if (result.status === "successful") {
      outcomes[axis] = { status: "successful", prompt: result.prompt, workspaceDisposition: result.workspaceDisposition, runtimeConstructionEvidence: result.runtimeConstructionEvidence };
      const text = result.report;
      reports[axis] = { text, utf8Length: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) };
    } else {
      outcomes[axis] = { status: "failed", prompt: result.prompt, workspaceDisposition: result.workspaceDisposition, failure: result.failure, ...(result.runtimeConstructionEvidence === undefined ? {} : { runtimeConstructionEvidence: result.runtimeConstructionEvidence }) };
    }
  }
  const accepted = input.record.accepted;
  const snapshotIdentity = accepted?.input.canonicalSkill.snapshotIdentity ?? input.canonicalSkillSnapshotIdentity;
  return freeze({
    version: 2,
    status: input.intent.status,
    ...(input.intent.status === "refused" ? { diagnostic: input.intent.diagnostic } : {}),
    ...(accepted === undefined ? {} : { acceptedBatch: { identity: accepted.identity, legs: accepted.legs.map(({ axis, prompt }) => ({ axis, prompt })) } }),
    reports,
    outcomes,
    identities: {
      canonicalSkill: { sha256: snapshotIdentity.sha256, utf8Length: snapshotIdentity.utf8Length, snapshotIdentity },
      ...(accepted === undefined ? {} : { construction: { recipe: accepted.recipe, bundle: accepted.bundle }, target: accepted.target }),
    },
  });
}
