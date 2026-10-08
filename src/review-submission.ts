/** One shared terminating receipt contract for review officers (#1028 / #1055). */
import { Type } from "typebox";

import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const REVIEW_SUBMISSION_OUTPUT_TOOL_NAME = "ak_submission_output" as const;

/** Single schema copy of the review queue words. Runtime membership reads this set. */
export const REVIEW_QUEUE_WORDS = ["converged", "continue", "escalate"] as const;
export type ReviewQueueWord = (typeof REVIEW_QUEUE_WORDS)[number];
export const REVIEW_QUEUE_STATUSES: ReadonlySet<string> = new Set(REVIEW_QUEUE_WORDS);

const reviewStatusField = Type.Union(
  [
    Type.Literal(REVIEW_QUEUE_WORDS[0]),
    Type.Literal(REVIEW_QUEUE_WORDS[1]),
    Type.Literal(REVIEW_QUEUE_WORDS[2]),
  ],
  {
    description: "审核席本轮裁决的判别状态。",
  },
);

/** Shared optional review narrative fields (generation guidance only). */
const reviewNarrativeFields = {
  findings: Type.Optional(Type.Unknown({ description: "审核发现，原样留存" })),
  reason: Type.Optional(Type.Unknown({ description: "上呈理由" })),
  violations: Type.Optional(Type.Unknown({ description: "违规条目" })),
  conflicts: Type.Optional(Type.Unknown({ description: "待决冲突" })),
  fix: Type.Optional(Type.Unknown({ description: "continue 时的补救说明；可写 summary 摘要，其余内容原样留存" })),
  classes: Type.Optional(Type.Unknown({ description: "已裁决 finding 类；可说明 name、owner、boundary、disposition，原样留存" })),
  note: Type.Optional(Type.Unknown({ description: "裁决附注" })),
  evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
  decisionGate: Type.Optional(Type.Unknown({ description: "需人权威处置的问题与选项；可说明 question、options，原样留存" })),
} as const;

/**
 * One object root. Codex structured output rejects a root anyOf, and status
 * stays a required three-state enum with no omitted-status failure branch.
 * External-dependency failure while the seat can still submit:
 * docs/adr/0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md
 */
export const reviewSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
    },
    { additionalProperties: true },
  ),
);

/**
 * #1195 ticket-court clause row: original ticket text, owner uuid (or null),
 * and one-line derivation. Dual readings of runner context live in derivation.
 * Generation-required on countersign/notary only; package still records as-is.
 */
export const courtClauseItemSchema = Type.Object(
  {
    clause: Type.String({
      description: "票面条款原文（改变实际行为的条款；不合并、不改写）",
    }),
    ownerUuid: Type.Union([Type.String(), Type.Null()], {
      description: "推出该条的陛下原话 uuid；无原话则 null",
    }),
    derivation: Type.String({
      description:
        "一句推导：从原话哪个意思到该条款。用作上下文的 runner 句先写至少两种读法，再写票面取哪种；写不出第二种才记无歧义",
    }),
  },
  { additionalProperties: true },
);

export const courtClausesField = Type.Array(courtClauseItemSchema, {
  description:
    "票面逐条核旨表：每条改变实际行为的条款的原文、陛下原话 uuid、推导。无原话则 ownerUuid 为 null。",
});

/**
 * Countersign + Notary generation schema (#1195): shared review face plus
 * required top-level clauses. Package execute does not reject a missing table.
 */
export const courtReviewSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
      clauses: courtClausesField,
    },
    { additionalProperties: true },
  ),
);

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
