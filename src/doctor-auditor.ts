import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import { loadAuditorSoul } from "./auditor-soul.ts";
import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import {
  readDoctorAuditSubjects,
  requireAuditMaterials,
  resolveAuditDossier,
} from "./dossier-resolution.ts";

export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";

export type DoctorAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const tool = createComplianceDecisionTool(
  DOCTOR_AUDIT_TOOL_NAME,
  "提交 typed pass/revise/escalate 决议（太医署审刑）。",
);

/**
 * Doctor auditor: zero hand-delivered materials.
 * Candidate testimony must already be on the parent-session books.
 */
export function createPiDoctorAuditor(): (options: DoctorAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    requireAuditMaterials(dossier);
    const subjects = readDoctorAuditSubjects(options.context);
    requireAuditMaterials(subjects);

    return runComplianceAudit({
      tool,
      systemPrompt: await loadAuditorSoul("doctor"),
      roleLabel: "Doctor Soul compliance audit",
      invalidDecisionLabel: "invalid Doctor audit decision",
      context: options.context,
      ...(auditorRunDirectory(options.context) === undefined ? {} : { runDirectory: auditorRunDirectory(options.context) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
}
