import type { ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import type { ReviewerIntent, RuntimeReviewerOutcome, RuntimeReviewerReceiptV2, VerbatimChildReport } from "./package-contracts/reviewer-output.ts";

export type { RuntimeReviewerOutcome, RuntimeReviewerReceiptV2, VerbatimChildReport } from "./package-contracts/reviewer-output.ts";

function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  if (value !== null && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)]))) as T;
  return value;
}

function receiptPrompt(prompt: string): Readonly<{ text: string }> {
  return Object.freeze({ text: prompt });
}

export function assembleRuntimeReviewerReceipt(input: {
  intent: ReviewerIntent;
  record: ReviewerExecutionRecord;
  /** Binding-owned Skill bytes/text projected onto the receipt without an identity shell. */
  canonicalSkillText: string;
}): RuntimeReviewerReceiptV2 {
  const reports: Partial<Record<"standards" | "spec", VerbatimChildReport>> = {};
  const outcomes: Partial<Record<"standards" | "spec", RuntimeReviewerOutcome>> = {};
  for (const axis of ["standards", "spec"] as const) {
    const result = input.record.results[axis];
    if (result === undefined) continue;
    if (result.status === "successful") {
      outcomes[axis] = {
        status: "successful",
        prompt: receiptPrompt(result.prompt),
        workspaceDisposition: result.workspaceDisposition,
      };
      reports[axis] = { text: result.report };
    } else {
      outcomes[axis] = {
        status: "failed",
        prompt: receiptPrompt(result.prompt),
        workspaceDisposition: result.workspaceDisposition,
        failure: result.failure,
        diagnostic: result.diagnostic,
      };
    }
  }
  const accepted = input.record.accepted;
  const skillText = accepted?.input.canonicalSkill ?? input.canonicalSkillText;
  return freeze({
    version: 2,
    status: input.intent.status,
    ...(input.intent.status === "refused" ? { diagnostic: input.intent.diagnostic } : {}),
    ...(accepted === undefined ? {} : {
      acceptedBatch: {
        identity: accepted.identity,
        legs: accepted.legs.map(({ axis, prompt }) => ({ axis, prompt: receiptPrompt(prompt) })),
      },
    }),
    reports,
    outcomes,
    identities: {
      canonicalSkill: { text: skillText },
      ...(accepted === undefined ? {} : { construction: { recipe: accepted.recipe }, target: accepted.target }),
    },
  });
}
