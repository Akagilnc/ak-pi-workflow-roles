import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadAuditorSoul } from "./auditor-soul.ts";
import { createComplianceDecisionTool, runComplianceAudit, type ComplianceDecision } from "./compliance-transport.ts";
import type { DoctorCase, DoctorSubmission } from "./doctor-contracts.ts";

export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
export type DoctorAuditInput = { soul: string; patient: DoctorCase; readRecord: Array<{ evidenceId: string; fullyRead: boolean }>; testimony: DoctorSubmission };
const tool = createComplianceDecisionTool(DOCTOR_AUDIT_TOOL_NAME, "Return whether the proposed Doctor testimony demonstrably follows the supplied Doctor Soul and frozen evidence record. Completed receipts are later augmented with runtime-owned cost; empty findings are valid.");
export function createPiDoctorAuditor() {
  return async (input: DoctorAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision> => {
    const frozenIndex = { version: input.patient.version, identity: input.patient.identity, cost: input.patient.cost, evidence: input.patient.evidence.map(({ id, kind, byteLength, contentLength, sha256 }) => ({ id, kind, byteLength, contentLength, sha256 })) };
    return runComplianceAudit({
    tool,
    systemPrompt: await loadAuditorSoul("doctor"),
    serializedInput: JSON.stringify({ soul: input.soul, frozenEvidenceIndex: frozenIndex, readRecord: input.readRecord, proposedTestimony: input.testimony }),
      roleLabel: "Doctor Soul compliance audit", invalidDecisionLabel: "invalid Doctor audit decision", context: options.context,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
}
