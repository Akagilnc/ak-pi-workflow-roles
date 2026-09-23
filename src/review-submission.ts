/** One shared terminating receipt contract for review officers (#1028). */
import { Type } from "typebox";

import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const REVIEW_SUBMISSION_OUTPUT_TOOL_NAME = "ak_submission_output" as const;

/** Open receipt: the queue reads only status; all other submitted fields ride unchanged. */
export const reviewSubmissionSchema = withTerminatingOutputDeclarations(
  openToolObject(
    Type.Object({
      status: Type.Optional(Type.Unknown({
        description: "converged | continue | escalate — 非三态时请重读后重交，勿改标。",
      })),
      findings: Type.Optional(Type.Unknown({ description: "审核发现，原样留存" })),
      reason: Type.Optional(Type.Unknown({ description: "上呈理由" })),
      violations: Type.Optional(Type.Unknown({ description: "违规条目" })),
      conflicts: Type.Optional(Type.Unknown({ description: "待决冲突" })),
      fix: Type.Optional(Type.Unknown({ description: "continue 时的补救说明" })),
      classes: Type.Optional(Type.Unknown({ description: "已裁决 finding 类及其修理边界" })),
      note: Type.Optional(Type.Unknown({ description: "裁决附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Optional(Type.Unknown({ description: "需人处置的问题与选项" })),
    }),
  ),
);

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
