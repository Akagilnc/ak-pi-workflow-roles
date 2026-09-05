import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import {
  runComplianceAudit,
  type ComplianceDecision,
  type ComplianceRoleSummon,
} from "./compliance-transport.ts";
import {
  readDoctorAuditSubjects,
  requireAuditMaterials,
  resolveAuditDossier,
} from "./dossier-resolution.ts";
import type { HostContext } from "./host-contracts.ts";

export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";

export type DoctorAuditOptions = {
  context: HostContext;
  signal?: AbortSignal;
  /** Same seam as runComplianceAudit options — offline tracers only. */
  summonRole?: ComplianceRoleSummon;
};

/**
 * Doctor compliance via the public doctor activation path (#675).
 * Same materials as direct `ak-role doctor` (doctor.md) — not an auditor substitute.
 */
export function createPiDoctorAuditor(): (options: DoctorAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    requireAuditMaterials(dossier);
    const subjects = readDoctorAuditSubjects(options.context);
    requireAuditMaterials(subjects);

    return runComplianceAudit({
      line: "doctor",
      context: options.context,
      ...(auditorRunDirectory(options.context) === undefined
        ? {}
        : { runDirectory: auditorRunDirectory(options.context) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.summonRole === undefined ? {} : { summonRole: options.summonRole }),
    });
  };
}
