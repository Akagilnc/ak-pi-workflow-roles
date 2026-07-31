import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceCompletion,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import type { ReviewerAuditInput } from "./reviewer-role.ts";

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
        "Check only target identity, canonical-Skill and construction-recipe identities, prompt and bundle evidence, required terminal outcomes, honest refusal, the compiled single-axis method/output contract, exact runtime report preservation, scratch-versus-target distinction, and Reviewer role boundaries.",
        "The unchanged canonical Skill controls each axis's substantive question and baseline. The package adapter controls this isolated leg's output mechanics and supersedes the Skill's dual-agent orchestration, aggregation, and dual-section presentation instructions.",
        "Require each successful report to answer only its assigned canonical question; revise for a second-axis assessment, finding count, conclusion, or section. Cross-axis material access or citation is lawful and is never by itself a violation.",
        "Never apply source allowlists, parse prose mechanically, or judge finding merit. Do not discover findings, rerank axes, rewrite reports, redo the review, decide mergeability, route work, or adjudicate the product.",
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
