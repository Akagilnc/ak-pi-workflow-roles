import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadAuditorSoul } from "./auditor-soul.ts";
import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import type { ReviewerAuditInput } from "./reviewer-role.ts";
import { reviewerAuditReadiness } from "./reviewer-audit-facts.ts";

export { reviewerAuditReadiness } from "./reviewer-audit-facts.ts";
export class ReviewerAuditEvidenceError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Reviewer audit evidence is incomplete: ${missing.join("; ")}`);
    this.name = "ReviewerAuditEvidenceError";
  }
}

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
): (
  input: ReviewerAuditInput,
  options: ReviewerAuditOptions,
) => Promise<ComplianceDecision> {
  return async (input, options) => {
    const readiness = reviewerAuditReadiness(input.record);
    if (!readiness.ready) throw new ReviewerAuditEvidenceError(readiness.missing);
    return runComplianceAudit({
      tool: reviewerDecisionTool,
      systemPrompt: await loadAuditorSoul("reviewer"),
      serializedInput: [
        "<reviewer_soul>", input.soul, "</reviewer_soul>",
        "<canonical_code_review_skill>", input.canonicalSkill,
        "</canonical_code_review_skill>",
        "<opaque_review_task>", input.task, "</opaque_review_task>",
        "<structured_execution_record>", JSON.stringify(input.record),
        "</structured_execution_record>",
        "<typed_material_and_coverage_facts>", JSON.stringify(readiness.materials),
        "</typed_material_and_coverage_facts>",
        "<candidate_receipt>", JSON.stringify(input.candidate),
        "</candidate_receipt>",
      ].join("\n"),
      roleLabel: "Reviewer compliance audit",
      invalidDecisionLabel: "invalid reviewer audit decision",
      context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
}
