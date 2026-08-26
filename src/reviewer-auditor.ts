import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import { loadAuditorSoul } from "./auditor-soul.ts";
import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceCompletion,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import {
  readReviewerAuditSubjects,
  requireAuditMaterials,
  resolveAuditDossier,
} from "./dossier-resolution.ts";

export const REVIEWER_AUDIT_TOOL_NAME = "ak_reviewer_audit_decision";

export type ReviewerAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const reviewerDecisionTool = createComplianceDecisionTool(
  REVIEWER_AUDIT_TOOL_NAME,
  "Decide whether the Reviewer receipt demonstrably followed its method and boundaries from the dossier.",
);

/**
 * Reviewer auditor: zero hand-delivered materials / no readiness projection.
 * Candidate receipt must already be on the parent-session books.
 */
export function createPiReviewerAuditor(
  runCompletion?: ComplianceCompletion,
): (options: ReviewerAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    requireAuditMaterials(dossier);
    const subjects = readReviewerAuditSubjects(options.context);
    requireAuditMaterials(subjects);

    return runComplianceAudit({
      tool: reviewerDecisionTool,
      systemPrompt: await loadAuditorSoul("reviewer"),
      roleLabel: "Reviewer compliance audit",
      invalidDecisionLabel: "invalid reviewer audit decision",
      ...(runCompletion === undefined ? {} : { runCompletion }),
      context: options.context,
      ...(auditorRunDirectory(options.context) === undefined ? {} : { runDirectory: auditorRunDirectory(options.context) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
}
