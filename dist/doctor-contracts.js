import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalJson } from "./canonical-json.js";
export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"];
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const count = Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank) }, { additionalProperties: false });
const finding = Type.Object({ targetKey: nonblank, targetKind: Type.Union(DOCTOR_TARGET_KINDS.map((kind) => Type.Literal(kind))), evidenceIds: Type.Array(nonblank, { minItems: 1 }), disposition: Type.Union([Type.Literal("keep"), Type.Literal("thin"), Type.Literal("delete")]), recommendation: nonblank }, { additionalProperties: false });
const caseIdentity = Type.Object({ issueNumber: Type.Integer({ minimum: 1 }), runsPath: nonblank }, { additionalProperties: false });
const cost = Type.Object({
    invocations: count, legs: count, modelApiTurns: count, outputTokens: count, toolCalls: count,
    retries: Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank), evidence: Type.Literal("literal run-dir naming") }, { additionalProperties: false }),
    statuses: Type.Array(Type.Object({ source: nonblank, status: nonblank }, { additionalProperties: false })),
    commits: Type.Array(Type.Object({ source: nonblank, commit: nonblank }, { additionalProperties: false })),
    sessions: Type.Array(Type.Object({ source: nonblank, startedAt: nonblank, endedAt: nonblank, wallMilliseconds: Type.Number({ minimum: 0 }), completion: Type.Union([Type.Literal("accepted"), Type.Literal("incomplete")]) }, { additionalProperties: false })),
    outputBytes: Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank), payload: Type.Literal("raw JSONL bytes"), providerWireBytes: Type.Literal("unavailable") }, { additionalProperties: false }),
}, { additionalProperties: false });
export const doctorOutputSchema = Type.Union([
    Type.Object({ status: Type.Literal("completed"), case: caseIdentity, cost, findings: Type.Array(finding) }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("refused"), reason: nonblank, missingEvidence: Type.Array(Type.Object({ need: nonblank, targetKeys: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
]);
export const doctorEvidenceReadSchema = Type.Object({ evidenceId: nonblank, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })) }, { additionalProperties: false });
export function validateRecordedDoctorOutput(value) { if (!Value.Check(doctorOutputSchema, value))
    throw new Error("Doctor output does not match its closed contract"); return value; }
export class DoctorEvidenceStore {
    patient;
    entries;
    readIds = new Set();
    constructor(patient) {
        this.patient = patient;
        this.entries = new Map(patient.evidence.map((entry) => [entry.id, entry]));
    }
    read(evidenceId, offset = 0, limit = 4096) { const entry = this.entries.get(evidenceId); if (!entry)
        throw new Error(`Evidence ID is not admitted: ${evidenceId}`); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096)
        throw new Error("Invalid evidence pagination"); if (offset > entry.content.length)
        throw new Error("Evidence offset exceeds content"); this.readIds.add(evidenceId); const end = Math.min(entry.content.length, offset + limit); return { evidenceId, kind: entry.kind, offset, content: entry.content.slice(offset, end), nextOffset: end < entry.content.length ? end : null, byteLength: entry.byteLength, sha256: entry.sha256 }; }
    hasRead(id) { return this.readIds.has(id); }
    readRecord() { return [...this.readIds].sort().map((evidenceId) => ({ evidenceId, fullyRead: true })); }
}
export function validateDoctorOutput(value, patient, store) {
    const output = validateRecordedDoctorOutput(value);
    if (output.status === "refused")
        return output;
    if (canonicalJson(output.case) !== canonicalJson(patient.identity) || canonicalJson(output.cost) !== canonicalJson(patient.cost))
        throw new Error("Every reported number must equal the re-derived session-byte cost");
    for (const finding of output.findings)
        for (const id of finding.evidenceIds)
            if (!store.entries.has(id) || !store.hasRead(id))
                throw new Error(`finding must cite admitted/read evidence: ${id}`);
    return output;
}
