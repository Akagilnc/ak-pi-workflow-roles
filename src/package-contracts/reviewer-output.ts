/** Package-owned Reviewer intent — original role payload only (#836 删 8). */

import { Type } from "typebox";

import { openToolObject } from "../open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./terminating-infrastructure.ts";

export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";

const REVIEWER_AMENDMENTS_DESCRIPTION =
  "已运行 lens 的 amendments 承载 candidates、逐条处置与 verdict 的完整报告（非仅 verdict 行）；显式单轴时另一轴可省略（completeness / correctness）。hard-stop／usage error 为 refused 时，已产出报告仍照录对应 lens 字段。" as const;
// #1134: `status` alone is the trajectory field (#917 §6 two normal lens verdicts →
// completed; hard-stop / usage error → refused); its words ride the description.
// amendments/diagnostic are LLM/human-read narrative content returned as
// submitted — declaration keeps name + semantic description only, no nested
// object shape, no string type, no required constraint.
const REVIEWER_STATUS_DESCRIPTION =
  "completed | refused。两种正常 lens verdict（completeness / correctness）均 completed；hard-stop 与 usage error 为 refused（已产出报告仍照录进所选 lens amendments）。" as const;
const reviewerOutputObject = Type.Object({
  status: Type.Unknown({ description: REVIEWER_STATUS_DESCRIPTION }),
  amendments: Type.Unknown({ description: REVIEWER_AMENDMENTS_DESCRIPTION }),
  diagnostic: Type.Unknown({
    description: "拒绝诊断说明；hard-stop／usage error 原因进此字段，已产出报告另照录 amendments",
  }),
});
export const reviewerOutputSchema = withTerminatingOutputDeclarations(
  openToolObject(reviewerOutputObject),
);

/** Seat-owned per-lens finding body text (completeness / correctness). */
export type ReviewerAmendments = Readonly<
  Partial<Record<"completeness" | "correctness", string>>
>;
export type ReviewerIntent =
  | Readonly<{ status: "completed"; amendments?: ReviewerAmendments }>
  | Readonly<{ status: "refused"; diagnostic: string; amendments?: ReviewerAmendments }>;

export function validateReviewerIntent(output: unknown): ReviewerIntent {
  return output as ReviewerIntent;
}
