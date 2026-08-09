import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import { loadAuditorSoul } from "./auditor-soul.ts";
import type { SoulAuditInput } from "./judge-role.ts";

export const JUDGE_AUDIT_TOOL_NAME = "ak_soul_audit_decision";
export const SOUL_AUDIT_TOOL_NAME = JUDGE_AUDIT_TOOL_NAME;

export type JudgeAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const auditDecisionTool = createComplianceDecisionTool(
  JUDGE_AUDIT_TOOL_NAME,
  "Return whether the proposed verdict demonstrably follows the supplied judge soul.",
);

export function createPiJudgeAuditor(
): (input: SoulAuditInput, options: JudgeAuditOptions) => Promise<ComplianceDecision> {
  return async (input, options) =>
    runComplianceAudit({
      tool: auditDecisionTool,
      systemPrompt: await loadAuditorSoul("judge"),
      serializedInput: [
        "<judge_soul>",
        input.soul,
        "</judge_soul>",
        "<adjudication_record>",
        input.transcript,
        "</adjudication_record>",
        "<proposed_verdict>",
        JSON.stringify(input.verdict),
        "</proposed_verdict>",
      ].join("\n"),
      roleLabel: "Soul compliance audit",
      invalidDecisionLabel: "invalid soul audit decision",
      context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
}
