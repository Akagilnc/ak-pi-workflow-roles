import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceCompletion,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import type { ReviewerAuditInput } from "./role-runtime.ts";

export const REVIEWER_AUDIT_TOOL_NAME = "ak_reviewer_audit_decision";

export type ReviewerAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const reviewerDecisionTool = createComplianceDecisionTool(
  REVIEWER_AUDIT_TOOL_NAME,
  "Decide whether the Reviewer receipt demonstrably followed its supplied method and boundaries.",
);

export function createPiReviewerAuditor(
  runCompletion?: ComplianceCompletion,
): (
  input: ReviewerAuditInput,
  options: ReviewerAuditOptions,
) => Promise<ComplianceDecision> {
  return async (input, options) =>
    runComplianceAudit({
      tool: reviewerDecisionTool,
      systemPrompt: [
        "You audit Reviewer method compliance; you are not a second substantive reviewer.",
        "Check only demonstrated method compliance, target traceability, honest refusal, Standards/Spec isolation and skip handling, faithful aggregation, scratch-versus-target distinction, and Reviewer role boundaries.",
        "Do not discover findings, rerank axes, redo the review, decide mergeability, route work, or adjudicate the product.",
        `Call ${REVIEWER_AUDIT_TOOL_NAME} exactly once. Use pass only when the supplied structured record demonstrates compliance; otherwise use revise with specific violations.`,
      ].join("\n"),
      serializedInput: [
        "<reviewer_soul>", input.soul, "</reviewer_soul>",
        "<canonical_code_review_skill>", input.canonicalSkill,
        "</canonical_code_review_skill>",
        "<opaque_review_task>", input.task, "</opaque_review_task>",
        "<structured_execution_record>", JSON.stringify(input.record),
        "</structured_execution_record>",
        "<candidate_receipt>", JSON.stringify(input.candidate),
        "</candidate_receipt>",
      ].join("\n"),
      roleLabel: "Reviewer compliance audit",
      invalidDecisionLabel: "invalid reviewer audit decision",
      ...(runCompletion === undefined ? {} : { runCompletion }),
      context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
}
