import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createComplianceDecisionTool,
  runComplianceAudit,
  type ComplianceCompletion,
} from "./compliance-transport.ts";
import type { SoulAuditInput, SoulAuditResult } from "./role-runtime.ts";

export const SOUL_AUDIT_TOOL_NAME = "ak_soul_audit_decision";

export type SoulAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const auditDecisionTool = createComplianceDecisionTool(
  SOUL_AUDIT_TOOL_NAME,
  "Return whether the proposed verdict demonstrably follows the supplied judge soul.",
);

export function createPiSoulAuditor(
  runCompletion?: ComplianceCompletion,
): (input: SoulAuditInput, options: SoulAuditOptions) => Promise<SoulAuditResult> {
  return async (input, options) =>
    runComplianceAudit({
      tool: auditDecisionTool,
      systemPrompt: [
        "You are a procedural compliance auditor, not a second judge.",
        "Determine only whether the proposed verdict demonstrably applied the supplied judge soul to the adjudication record.",
        "Do not replace the judge's substantive finding decisions with your own.",
        `Call ${SOUL_AUDIT_TOOL_NAME} exactly once. Use pass only when the record demonstrates compliance; otherwise use revise and name each violated soul rule.`,
      ].join("\n"),
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
      ...(runCompletion === undefined ? {} : { runCompletion }),
      context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
}
