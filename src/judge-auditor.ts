import {
  runComplianceAudit,
  type AuditorSummon,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import {
  readJudgeAuditSubjects,
  requireAuditMaterials,
  resolveAuditDossier,
} from "./dossier-resolution.ts";
import type { HostContext } from "./host-contracts.ts";

export const JUDGE_AUDIT_TOOL_NAME = "ak_soul_audit_decision";
export const SOUL_AUDIT_TOOL_NAME = JUDGE_AUDIT_TOOL_NAME;

export type JudgeAuditOptions = {
  context: HostContext;
  signal?: AbortSignal;
  /** Same seam as runComplianceAudit options — offline tracers only. */
  summonAuditor?: AuditorSummon;
};

/**
 * Judge compliance via the public auditor activation path (#675).
 * Materials/soul/tool owned by the public auditor seat — same assembly as a
 * direct `ak-role auditor` call (judge.md criteria included there).
 */
export function createPiJudgeAuditor(): (options: JudgeAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    requireAuditMaterials(dossier);
    const subjects = readJudgeAuditSubjects(options.context);
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
