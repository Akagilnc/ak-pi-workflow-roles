import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import {
  runComplianceAudit,
  type AuditorSummon,
  type ComplianceDecision,
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
  summonAuditor?: AuditorSummon;
};

/**
 * Doctor compliance via public auditor activation (#675 / ADR 0062).
 * 审刑院 is an independent role — not a re-summon of doctor (no self-audit recursion).
 * Auditor materials = direct `ak-role auditor` assembly (auditor.md).
 */
export function createPiDoctorAuditor(): (options: DoctorAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    requireAuditMaterials(dossier);
    const subjects = readDoctorAuditSubjects(options.context);
    requireAuditMaterials(subjects);

    return runComplianceAudit({
      context: options.context,
      ...(auditorRunDirectory(options.context) === undefined
        ? {}
        : { runDirectory: auditorRunDirectory(options.context) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.summonAuditor === undefined ? {} : { summonAuditor: options.summonAuditor }),
    });
  };
}
