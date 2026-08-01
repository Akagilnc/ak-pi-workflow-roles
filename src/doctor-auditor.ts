import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createComplianceDecisionTool, runComplianceAudit, type ComplianceCompletion, type ComplianceDecision } from "./compliance-transport.ts";
import type { DoctorCase, DoctorOutput } from "./doctor-contracts.ts";

export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
export type DoctorAuditInput = { soul: string; patient: DoctorCase; readRecord: Array<{ evidenceId: string; fullyRead: boolean }>; output: DoctorOutput };
const tool = createComplianceDecisionTool(DOCTOR_AUDIT_TOOL_NAME, "Return whether the proposed Doctor output demonstrably follows the supplied Doctor Soul and frozen evidence record.");
export function createPiDoctorAuditor(runCompletion?: ComplianceCompletion) {
  return (input: DoctorAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision> => {
    const frozenIndex = { version: input.patient.version, identity: input.patient.identity, cost: input.patient.cost, evidence: input.patient.evidence.map(({ id, kind, byteLength, contentLength, sha256 }) => ({ id, kind, byteLength, contentLength, sha256 })) };
    return runComplianceAudit({
    tool,
    systemPrompt: [
      "You are an isolated procedural compliance auditor, not a second Doctor.",
      "Check whether the proposed typed output demonstrably follows the supplied Doctor Soul using only the frozen admitted evidence and read record.",
      "Do not replace medical judgment or invent evidence.",
      `Call ${DOCTOR_AUDIT_TOOL_NAME} exactly once; pass requires no violations and revise names every procedural violation.`,
    ].join("\n"),
    serializedInput: ["<doctor_soul>", input.soul, "</doctor_soul>", "<frozen_evidence_index>", JSON.stringify(frozenIndex), "</frozen_evidence_index>", "<read_record>", JSON.stringify(input.readRecord), "</read_record>", "<proposed_doctor_output>", JSON.stringify(input.output), "</proposed_doctor_output>"].join("\n"),
      roleLabel: "Doctor Soul compliance audit", invalidDecisionLabel: "invalid Doctor audit decision", context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }), ...(runCompletion === undefined ? {} : { runCompletion }),
    });
  };
}
