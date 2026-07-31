import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME, DoctorEvidenceStore, doctorEvidenceReadSchema, doctorOutputSchema, validateDoctorEvidenceIndex, validateDoctorOutput, type DoctorEvidenceIndexV1 } from "./doctor-contracts.ts";

export { DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME };
export type DoctorRoleDependencies = {
  loadSoul(): Promise<string>; loadEvidenceIndex(path: string): Promise<unknown>;
  auditCompliance(input: DoctorAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
};
export type DoctorAuditInput = import("./doctor-auditor.ts").DoctorAuditInput;
function singleton(toolCallId: string, ctx: ExtensionContext) { const leaf = ctx.sessionManager.getLeafEntry(); if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("Doctor output must be the sole final tool call"); const calls = leaf.message.content.filter((part) => part.type === "toolCall"); if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== DOCTOR_OUTPUT_TOOL_NAME) throw new Error("Doctor output must be the sole final tool call"); }
export function createDoctorRoleRuntime(pi: ExtensionAPI, dependencies: DoctorRoleDependencies, host: { failInfrastructure(error: unknown, ctx: ExtensionContext): never }) {
  let activation: { soul: string; index: DoctorEvidenceIndexV1; store: DoctorEvidenceStore } | undefined; let registered = false;
  pi.registerFlag("ak-doctor-evidence", { description: "Path to a frozen Doctor v1 evidence index JSON file", type: "string" });
  return { async activate() {
    const path = pi.getFlag("ak-doctor-evidence"); if (typeof path !== "string" || path.trim() === "") throw new Error("Doctor requires --ak-doctor-evidence");
    const soul = (await dependencies.loadSoul()).trim(); if (!soul) throw new Error("Doctor soul is empty");
    const index = validateDoctorEvidenceIndex(await dependencies.loadEvidenceIndex(path)); activation = { soul, index, store: new DoctorEvidenceStore(index) };
    if (!registered) { registered = true;
      pi.registerTool({ name: DOCTOR_EVIDENCE_TOOL_NAME, label: "Doctor Evidence", description: "Read one admitted frozen evidence ID with bounded pagination.", promptSnippet: "Read admitted Doctor evidence", promptGuidelines: ["Read only evidence IDs from the frozen catalog."], parameters: doctorEvidenceReadSchema,
        async execute(_id, params: { evidenceId: string; offset?: number; limit?: number }) { if (!activation) throw new Error("Doctor is not activated"); const details = activation.store.read(params.evidenceId, params.offset, params.limit); return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details }; } });
      pi.registerTool({ name: DOCTOR_OUTPUT_TOOL_NAME, label: "Doctor Output", description: "Submit the sole final typed Doctor examination result for compliance audit.", promptSnippet: "Submit the Doctor examination", promptGuidelines: [`Use ${DOCTOR_OUTPUT_TOOL_NAME} as the sole final action.`], parameters: doctorOutputSchema,
        async execute(id, params, signal, _update, ctx) { if (!activation) throw new Error("Doctor is not activated"); singleton(id, ctx); const output = validateDoctorOutput(params, activation.index, activation.store); let audit: ComplianceDecision; try { audit = await dependencies.auditCompliance({ soul: activation.soul, index: activation.index, readRecord: activation.store.readRecord(), output }, signal === undefined ? { context: ctx } : { context: ctx, signal }); } catch (error) { host.failInfrastructure(error, ctx); } if (audit.status === "revise") throw new Error(`Doctor output violates its soul: ${audit.violations.join("; ")}`); return { content: [{ type: "text" as const, text: "Doctor output accepted" }], details: output, terminate: true as const, ...(audit.usage === undefined ? {} : { usage: audit.usage }) }; } });
      pi.on("before_agent_start", (event) => { if (!activation) throw new Error("Doctor is not activated"); const modelIndex = { version: activation.index.version, repository: activation.index.repository, targetCommit: activation.index.targetCommit, catalog: activation.index.catalog, populations: activation.index.populations, evidence: activation.index.evidence.map(({ id, kind, sha256, byteLength }) => ({ id, kind, sha256, byteLength })) }; return { systemPrompt: `${event.systemPrompt}\n\n<doctor_soul>\n${activation.soul}\n</doctor_soul>\n\n<doctor_evidence_index>\n${JSON.stringify(modelIndex)}\n</doctor_evidence_index>` }; });
    }
    const required = [DOCTOR_EVIDENCE_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME]; const names = pi.getAllTools().map((tool) => tool.name); for (const name of required) if (names.filter((item) => item === name).length !== 1) throw new Error(`Doctor required tool collision or missing: ${name}`); pi.setActiveTools(required); const active = pi.getActiveTools?.() ?? required; if (active.length !== 2 || !required.every((name) => active.includes(name))) throw new Error("Doctor active tool narrowing failed");
  } };
}
