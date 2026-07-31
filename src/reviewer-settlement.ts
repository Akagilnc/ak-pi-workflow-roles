import { sha256Hex } from "./sha256.ts";
import type { ReviewerAcceptedEvidence, ReviewerExecutionRecord, ReviewerFailureClassification, ReviewerWorkspaceDisposition } from "./reviewer-execution-ledger.ts";
import type { ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

export type VerbatimChildReport = Readonly<{ text: string; utf8Length: number; sha256: string }>;
export type RuntimeReviewerOutcome = Readonly<{
  status: "successful" | "failed";
  prompt: ReviewerPromptIdentity;
  workspaceDisposition: ReviewerWorkspaceDisposition;
  failure?: ReviewerFailureClassification;
}>;
export type RuntimeReviewerReceiptV2 = Readonly<{
  version: 2;
  status: "completed" | "refused";
  diagnostic?: string;
  batchIdentity?: string;
  reports: Readonly<Partial<Record<"standards" | "spec", VerbatimChildReport>>>;
  outcomes: Readonly<Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>>>;
  identities: Readonly<{
    canonicalSkill: Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: string }>;
    construction?: Readonly<Pick<ReviewerAcceptedEvidence, "recipe" | "bundle">>;
    target?: ReviewerAcceptedEvidence["target"];
  }>;
}>;

function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  if (value !== null && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)]))) as T;
  return value;
}

export function assembleRuntimeReviewerReceipt(input: {
  intent: Readonly<{ status: "completed" } | { status: "refused"; diagnostic: string }>;
  record: ReviewerExecutionRecord;
  canonicalSkill: Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: string }>;
}): RuntimeReviewerReceiptV2 {
  const reports: Partial<Record<"standards" | "spec", VerbatimChildReport>> = {};
  const outcomes: Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>> = {};
  for (const axis of ["standards", "spec"] as const) {
    const result = input.record.results[axis];
    if (result === undefined) continue;
    outcomes[axis] = {
      status: result.status,
      prompt: result.prompt,
      workspaceDisposition: result.workspaceDisposition,
      ...(result.failure === undefined ? {} : { failure: result.failure }),
    };
    if (result.status === "successful") {
      const text = result.report!;
      reports[axis] = { text, utf8Length: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) };
    }
  }
  const accepted = input.record.accepted;
  return freeze({
    version: 2,
    status: input.intent.status,
    ...(input.intent.status === "refused" ? { diagnostic: input.intent.diagnostic } : {}),
    ...(accepted === undefined ? {} : { batchIdentity: accepted.identity }),
    reports,
    outcomes,
    identities: {
      canonicalSkill: input.canonicalSkill,
      ...(accepted === undefined ? {} : { construction: { recipe: accepted.recipe, bundle: accepted.bundle }, target: accepted.target }),
    },
  });
}
