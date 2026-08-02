import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createComplianceDecisionTool, runComplianceAudit, type ComplianceCompletion, type ComplianceDecision } from "./compliance-transport.ts";
import type { DoctorCase, DoctorSubmission } from "./doctor-contracts.ts";

export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
export type DoctorAuditInput = { soul: string; patient: DoctorCase; readRecord: Array<{ evidenceId: string; fullyRead: boolean }>; testimony: DoctorSubmission };
const tool = createComplianceDecisionTool(DOCTOR_AUDIT_TOOL_NAME, "Return whether the proposed Doctor testimony demonstrably follows the supplied Doctor Soul and frozen evidence record. Completed receipts are later augmented with runtime-owned cost; empty findings are valid.");
export function createPiDoctorAuditor(runCompletion?: ComplianceCompletion) {
  return (input: DoctorAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision> => {
    const frozenIndex = { version: input.patient.version, identity: input.patient.identity, cost: input.patient.cost, evidence: input.patient.evidence.map(({ id, kind, byteLength, contentLength, sha256 }) => ({ id, kind, byteLength, contentLength, sha256 })) };
    return runComplianceAudit({
    tool,
    systemPrompt: [
      "You are an isolated procedural compliance auditor, not a second Doctor.",
      "Check whether the proposed typed testimony demonstrably follows the supplied Doctor Soul using only the frozen admitted evidence and read record. Empty findings are contract-valid; the runtime later augments completed testimony with cost.",
      "Do not replace medical judgment or invent evidence.",
      `Call ${DOCTOR_AUDIT_TOOL_NAME} exactly once; pass requires no violations and revise names every procedural violation.`,
    ].join("\n"),
    serializedInput: JSON.stringify({ soul: input.soul, frozenEvidenceIndex: frozenIndex, readRecord: input.readRecord, proposedTestimony: input.testimony }),
      roleLabel: "Doctor Soul compliance audit", invalidDecisionLabel: "invalid Doctor audit decision", context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }), ...(runCompletion === undefined ? {} : { runCompletion }),
    });
  };
}
