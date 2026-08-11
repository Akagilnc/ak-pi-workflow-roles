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
  readDoctorAuditSubjects,
  resolveAuditDossier,
  toAuditIncomplete,
} from "./dossier-resolution.ts";

export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";

export type DoctorAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const tool = createComplianceDecisionTool(
  DOCTOR_AUDIT_TOOL_NAME,
  "Return whether the proposed Doctor testimony demonstrably follows the Doctor Soul and frozen evidence record from the dossier. Completed receipts are later augmented with runtime-owned cost; empty findings are valid.",
);

/**
 * Doctor auditor: zero hand-delivered materials.
 * Candidate testimony must already be on the parent-session books.
 */
export function createPiDoctorAuditor(
  runCompletion?: ComplianceCompletion,
): (options: DoctorAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    if (dossier.status === "incomplete") return toAuditIncomplete(dossier.observation);
    const subjects = readDoctorAuditSubjects(options.context);
    if (subjects.status === "incomplete") return toAuditIncomplete(subjects.observation);

    return runComplianceAudit({
      tool,
      systemPrompt: await loadAuditorSoul("doctor"),
      roleLabel: "Doctor Soul compliance audit",
      invalidDecisionLabel: "invalid Doctor audit decision",
      context: options.context,
      ...(auditorRunDirectory(options.context) === undefined ? {} : { runDirectory: auditorRunDirectory(options.context) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(runCompletion === undefined ? {} : { runCompletion }),
    });
  };
}
