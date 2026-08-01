import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createComplianceDecisionTool, runComplianceAudit, type ComplianceCompletion, type ComplianceDecision } from "./compliance-transport.ts";
import type { FixerAuditInput } from "./worker-role.ts";

export const FIXER_AUDIT_TOOL_NAME = "ak_fixer_audit_decision";
const tool = createComplianceDecisionTool(FIXER_AUDIT_TOOL_NAME, "Decide whether the Fixer candidate demonstrably complies with its supplied law and assignment.");

export function createPiFixerAuditor(runCompletion?: ComplianceCompletion): (input: FixerAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }) => Promise<ComplianceDecision> {
  return async (input, options) => runComplianceAudit({
    tool,
    systemPrompt: [
      "You are a Fixer compliance auditor, not a repair worker or substantive judge.",
      "Check only demonstrated Soul, typed packet declarations, opaque packet instructions, and invocation-record compliance, including honest coverage and lawful dispositions.",
      "You must not repair, retry work, decide finding merit, route the receipt, or adjudicate it.",
      "Revise workload, elapsed-time, incomplete-progress, or dishonest blocker relabeling; infrastructure failures are not lawful blockers.",
      "Treat prerequisite_unmet prospectively and within the assigned work: at disposition time, the referenced declared predecessor artifact, decision, or state must still be absent, and that absence must make the remaining assignment presently unlawful to execute. This semantic judgment is nondeterministic; typed declaration/reference integrity alone does not prove absence or causation.",
      "A missed method step, missing proof of past method compliance, forward commit ordering, or inability to rewrite history is not a prerequisite. Revise any refusal based on those retrospective conditions.",
      "When assigned findings are complete despite irreversible method noncompliance, require completed results, truthful breach disclosure, only currently demonstrated verification, and no claim of TDD or red-before-green. Pass that corrected settlement unless another demonstrated violation exists.",
      `Call ${FIXER_AUDIT_TOOL_NAME} exactly once. Pass only demonstrated compliance; otherwise revise with specific violations.`,
    ].join("\n"),
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
