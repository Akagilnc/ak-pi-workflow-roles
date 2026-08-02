import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadAuditorSoul } from "./auditor-soul.ts";
import { createComplianceDecisionTool, runComplianceAudit, type ComplianceCompletion, type ComplianceDecision } from "./compliance-transport.ts";
import type { FixerAuditInput } from "./worker-role.ts";

export const FIXER_AUDIT_TOOL_NAME = "ak_fixer_audit_decision";
const tool = createComplianceDecisionTool(FIXER_AUDIT_TOOL_NAME, "Decide whether the Fixer candidate demonstrably complies with its supplied law and assignment.");

export function createPiFixerAuditor(runCompletion?: ComplianceCompletion): (input: FixerAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }) => Promise<ComplianceDecision> {
  return async (input, options) => runComplianceAudit({
    tool,
    systemPrompt: await loadAuditorSoul("fixer"),
    serializedInput: [
      "<fixer_soul>", input.soul, "</fixer_soul>",
      "<fix_packet>", JSON.stringify(input.packet), "</fix_packet>",
      "<fixer_phase>", input.phase, "</fixer_phase>",
      "<invocation_record>", input.transcript, "</invocation_record>",
      "<candidate_receipt>", JSON.stringify(input.candidate), "</candidate_receipt>",
    ].join("\n"),
    roleLabel: "Fixer compliance audit",
    invalidDecisionLabel: "invalid fixer audit decision",
    ...(runCompletion === undefined ? {} : { runCompletion }),
    context: options.context,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
