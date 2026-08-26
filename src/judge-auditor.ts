import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceCompletion,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import { loadAuditorSoul } from "./auditor-soul.ts";
import {
  readJudgeAuditSubjects,
  resolveAuditDossier,
  toAuditIncomplete,
} from "./dossier-resolution.ts";

export const JUDGE_AUDIT_TOOL_NAME = "ak_soul_audit_decision";
export const SOUL_AUDIT_TOOL_NAME = JUDGE_AUDIT_TOOL_NAME;

export type JudgeAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const auditDecisionTool = createComplianceDecisionTool(
  JUDGE_AUDIT_TOOL_NAME,
  "Return whether the proposed verdict demonstrably follows the audit law and Judge role boundaries from the dossier evidence.",
);

/**
 * Judge auditor: zero hand-delivered materials. Subjects recovered from the
 * parent-session books. Public CLI injects AK_ROLE_RUN_DIR; bare Pi (ADR 0052)
 * proceeds without that pointer and self-locates per soul.
 */
export function createPiJudgeAuditor(
  runCompletion?: ComplianceCompletion,
): (options: JudgeAuditOptions) => Promise<ComplianceDecision> {
  return async (options) => {
    const dossier = resolveAuditDossier();
    if (dossier.status === "incomplete") return toAuditIncomplete(dossier.observation);
    const subjects = readJudgeAuditSubjects(options.context);
    if (subjects.status === "incomplete") return toAuditIncomplete(subjects.observation);

    return runComplianceAudit({
      tool: auditDecisionTool,
      systemPrompt: await loadAuditorSoul("judge"),
      roleLabel: "Judge compliance audit",
      invalidDecisionLabel: "invalid judge audit decision",
      ...(runCompletion === undefined ? {} : { runCompletion }),
      context: options.context,
      ...(auditorRunDirectory(options.context) === undefined ? {} : { runDirectory: auditorRunDirectory(options.context) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
}
