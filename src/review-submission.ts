/** One shared terminating receipt contract for review officers (#1028 / #1055). */
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const REVIEW_SUBMISSION_OUTPUT_TOOL_NAME = "ak_submission_output" as const;

/** Single schema copy of the review queue words. Runtime membership reads this set. */
export const REVIEW_QUEUE_WORDS = ["converged", "continue", "escalate"] as const;
export type ReviewQueueWord = (typeof REVIEW_QUEUE_WORDS)[number];
export const REVIEW_QUEUE_STATUSES: ReadonlySet<string> = new Set(REVIEW_QUEUE_WORDS);

/** Open receipt: the queue reads only status; all other submitted fields ride unchanged. */
export const reviewSubmissionSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      status: Type.Union(
        [
          Type.Literal(REVIEW_QUEUE_WORDS[0]),
          Type.Literal(REVIEW_QUEUE_WORDS[1]),
          Type.Literal(REVIEW_QUEUE_WORDS[2]),
        ],
        {
          description: "审核队列判别。宿主生成端枚举约束；包侧不因格式拒收。",
        },
      ),
      findings: Type.Optional(Type.Unknown({ description: "审核发现，原样留存" })),
      reason: Type.Optional(Type.Unknown({ description: "上呈理由" })),
      violations: Type.Optional(Type.Unknown({ description: "违规条目" })),
      conflicts: Type.Optional(Type.Unknown({ description: "待决冲突" })),
      fix: Type.Optional(Type.Unknown({ description: "continue 时的补救说明；可写 summary 摘要，其余内容原样留存" })),
      classes: Type.Optional(Type.Unknown({ description: "已裁决 finding 类；可说明 name、owner、boundary、disposition，原样留存" })),
      note: Type.Optional(Type.Unknown({ description: "裁决附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Optional(Type.Unknown({ description: "需人权威处置的问题与选项；可说明 question、options，原样留存" })),
    }),
    { required: ["status"] },
  ),
);

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
