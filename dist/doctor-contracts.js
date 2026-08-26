import { Type } from "typebox";
import { canonicalJson } from "./canonical-json.js";
import { openToolObjectFromUnion } from "./open-tool-schema.js";
export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_OUTPUT_TOOL_DESCRIPTION = "Submit the sole final typed single-case testimony. Use completed when findings is empty or contains only non-prescriptive case observations. The runtime adds its derived case cost to the accepted receipt. Refuse only when the evidence cannot support even truthful case testimony; unavailable reusable-asset or bounded-bite evidence blocks only the corresponding asset prescription.";
export const DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"];
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const count = Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank) }, { additionalProperties: false });
const evidenceIds = Type.Array(nonblank, { minItems: 1 });
const guardrail = Type.Object({ answer: Type.Boolean(), evidenceIds, explanation: nonblank }, { additionalProperties: false });
const lastRealBite = Type.Union([
    Type.Object({ kind: Type.Literal("actual"), targetKey: nonblank, evidenceId: nonblank }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("noRealBite"), targetKey: nonblank, eligibleEvidenceIds: evidenceIds }, { additionalProperties: false }),
]);
const assetKinds = DOCTOR_TARGET_KINDS;
const findingBody = {
    evidenceIds, disposition: Type.Union([Type.Literal("keep"), Type.Literal("thin"), Type.Literal("delete")]),
    guardrails: Type.Object({ reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: guardrail }, { additionalProperties: true }),
    prescription: Type.Object({ kind: Type.Union([Type.Literal("retain"), Type.Literal("delete"), Type.Literal("simplify"), Type.Literal("patch"), Type.Literal("addMechanism")]), recommendation: nonblank, necessityExplanation: Type.Optional(nonblank) }, { additionalProperties: false }), lastRealBite,
};
const finding = Type.Union([
    Type.Object({ targetKey: nonblank, observation: nonblank, evidenceIds }, { additionalProperties: false }),
    Type.Object({ targetKey: nonblank, targetKind: Type.Union(assetKinds.map((kind) => Type.Literal(kind))), assetEvidence: Type.Object({ targetKey: nonblank, targetKind: Type.Union(assetKinds.map((kind) => Type.Literal(kind))), evidenceId: nonblank }, { additionalProperties: false }), ...findingBody }, { additionalProperties: false }),
]);
const caseIdentity = Type.Object({ issueNumber: Type.Integer({ minimum: 1 }), runsPath: nonblank }, { additionalProperties: false });
const cost = Type.Object({
    invocations: count, legs: count, modelApiTurns: count, outputTokens: count, toolCalls: count,
    retries: Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank), evidence: Type.Literal("literal run-dir naming") }, { additionalProperties: false }),
    statuses: Type.Array(Type.Object({ source: nonblank, status: nonblank }, { additionalProperties: false })),
    commits: Type.Array(Type.Object({ source: nonblank, commit: nonblank }, { additionalProperties: false })),
    sessions: Type.Array(Type.Union([
        Type.Object({ source: nonblank, startedAt: nonblank, endedAt: nonblank, wallMilliseconds: Type.Number({ minimum: 0 }), completion: Type.Literal("accepted") }, { additionalProperties: false }),
        Type.Object({ source: nonblank, startedAt: Type.Optional(nonblank), endedAt: Type.Optional(nonblank), wallMilliseconds: Type.Optional(Type.Number({ minimum: 0 })), completion: Type.Literal("incomplete"), degradationReason: Type.Optional(nonblank) }, { additionalProperties: false }),
    ])),
    outputBytes: Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank), payload: Type.Literal("raw JSONL bytes"), providerWireBytes: Type.Literal("unavailable") }, { additionalProperties: false }),
}, { additionalProperties: false });
const doctorSubmissionVariants = Type.Union([
    Type.Object({
        status: Type.Literal("completed", { description: "Truthful single-case testimony was completed; the runtime adds derived cost to the receipt." }),
        case: Type.Unsafe({ ...caseIdentity, description: "Identity of the retained Doctor case." }),
        findings: Type.Array(finding, { description: "May be empty or contain non-prescriptive case observations. Missing reusable-asset or bounded-bite evidence excludes only the corresponding asset prescription." }),
    }, { additionalProperties: false, description: "Single-case testimony, without requiring any prescription or reusable finding." }),
    Type.Object({
        status: Type.Literal("refused", { description: "Reserved for inability to support truthful case testimony, not for an unavailable prescription axis." }),
        reason: Type.String({ minLength: 1, description: "Reason evidence is insufficient for truthful testimony." }),
        missingEvidence: Type.Array(Type.Object({ need: nonblank, targetKeys: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1, description: "Evidence required before truthful testimony is possible." }),
    }, { additionalProperties: false, description: "Evidence is insufficient for truthful case testimony." }),
]);
export const doctorSubmissionSchema = openToolObjectFromUnion(doctorSubmissionVariants);
export const doctorOutputSchema = Type.Union([
    Type.Object({ status: Type.Literal("completed"), case: caseIdentity, findings: Type.Array(finding), cost }, { additionalProperties: false }),
    doctorSubmissionVariants.anyOf[1],
]);
export const doctorEvidenceReadSchema = Type.Object({ evidenceId: Type.String({ minLength: 1, description: "Identifier of the retained evidence to read." }), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based byte offset at which to begin reading." })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "Maximum number of bytes to return." })) }, { additionalProperties: false });
export class DoctorSubmissionContractError extends Error {
    name = "DoctorSubmissionContractError";
}
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function read(value, key) { if (!isRecord(value))
    return undefined; try {
    return value[key];
}
catch {
    return undefined;
} }
export function validateDoctorSubmissionShape(value) {
    const status = read(value, "status");
    if (status !== "completed" && status !== "refused")
        throw new DoctorSubmissionContractError("Doctor submission has no recognized execution status");
    return value;
}
export function validateRecordedDoctorOutput(value) {
    const output = validateDoctorSubmissionShape(value);
    const status = read(output, "status");
    if (status === "completed" && read(output, "cost") === undefined)
        throw new Error("Completed Doctor receipt has no runtime-owned cost testimony");
    return output;
}
export class DoctorEvidenceStore {
    patient;
    entries;
    coverage = new Map();
    constructor(patient) {
        this.patient = patient;
        this.entries = new Map(patient.evidence.map((entry) => [entry.id, entry]));
    }
    read(evidenceId, offset = 0, limit = 4096) { const entry = this.entries.get(evidenceId); if (!entry)
        throw new Error(`Evidence ID is not admitted: ${evidenceId}`); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096)
        throw new Error("Invalid evidence pagination"); if (offset > entry.contentLength)
        throw new Error("Evidence offset exceeds content"); const end = Math.min(entry.contentLength, offset + limit); const ranges = [...(this.coverage.get(evidenceId) ?? []), [offset, end]].sort((a, b) => a[0] - b[0]); const merged = []; for (const range of ranges) {
        const prior = merged.at(-1);
        if (prior && range[0] <= prior[1])
            prior[1] = Math.max(prior[1], range[1]);
        else
            merged.push([...range]);
    } this.coverage.set(evidenceId, merged); return { evidenceId, kind: entry.kind, offset, content: entry.content.slice(offset, end), nextOffset: end < entry.contentLength ? end : null, contentLength: entry.contentLength, byteLength: entry.byteLength, sha256: entry.sha256 }; }
    hasRead(id) { const entry = this.entries.get(id); const ranges = this.coverage.get(id); return !!entry && ranges?.length === 1 && ranges[0][0] === 0 && ranges[0][1] === entry.contentLength; }
    readRecord() { return [...this.coverage.keys()].sort().map((evidenceId) => ({ evidenceId, fullyRead: this.hasRead(evidenceId) })); }
}
export function validateDoctorOutput(value, patient, store) {
    const output = validateDoctorSubmissionShape(value);
    const lawfulTargets = new Set(["case", ...patient.cost.invocations.sources]);
    const assertTarget = (targetKey) => { if (typeof targetKey === "string" && !lawfulTargets.has(targetKey))
        throw new Error(`Target key is not a lawful case target: ${targetKey}`); };
    const readCitations = (ids, label) => { if (!Array.isArray(ids))
        return; for (const id of ids)
        if (typeof id === "string" && (!store.entries.has(id) || !store.hasRead(id)))
            throw new Error(`${label} must cite admitted/read evidence: ${id}`); };
    if (read(output, "status") === "refused") {
        const missingEvidence = read(output, "missingEvidence");
        if (Array.isArray(missingEvidence))
            for (const missing of missingEvidence) {
                const targets = read(missing, "targetKeys");
                if (Array.isArray(targets))
                    for (const target of targets)
                        assertTarget(target);
            }
        return output;
    }
    const identity = read(output, "case");
    const issueNumber = read(identity, "issueNumber");
    const runsPath = read(identity, "runsPath");
    if ((issueNumber !== undefined && issueNumber !== patient.identity.issueNumber) || (runsPath !== undefined && runsPath !== patient.identity.runsPath))
        throw new Error("Doctor submission case must equal the activated case identity");
    const findings = read(output, "findings");
    if (!Array.isArray(findings))
        return output;
    for (const finding of findings) {
        const targetKey = read(finding, "targetKey");
        readCitations(read(finding, "evidenceIds"), "finding");
        const assetEvidence = read(finding, "assetEvidence");
        if (!isRecord(assetEvidence)) {
            assertTarget(targetKey);
            continue;
        }
        const assetTargetKey = read(assetEvidence, "targetKey");
        const assetTargetKind = read(assetEvidence, "targetKind");
        const assetEvidenceId = read(assetEvidence, "evidenceId");
        if (typeof assetTargetKey === "string" && assetTargetKey !== targetKey)
            throw new Error("Typed asset evidence must establish the finding target key");
        if (typeof assetTargetKind === "string" && assetTargetKind !== read(finding, "targetKind"))
            throw new Error("Typed asset evidence must establish the finding target kind");
        if (typeof assetEvidenceId === "string")
            readCitations([assetEvidenceId], "asset evidence");
        const guardrails = read(finding, "guardrails");
        for (const key of ["reproducibleFailure", "owningSeamOrInvariant", "deletionOrSimplificationSuffices"])
            readCitations(read(read(guardrails, key), "evidenceIds"), "guardrail");
        const bite = read(finding, "lastRealBite");
        const biteKind = read(bite, "kind");
        if (biteKind !== "actual" && biteKind !== "noRealBite")
            continue;
        if (read(bite, "targetKey") !== targetKey)
            throw new Error("lastRealBite target mismatch");
        if (biteKind === "actual") {
            const evidenceId = read(bite, "evidenceId");
            const entry = typeof evidenceId === "string" ? store.entries.get(evidenceId) : undefined;
            if (!entry || entry.kind !== "session" || !store.hasRead(entry.id))
                throw new Error("actual bite must cite an admitted/read retained session");
        }
        else {
            const eligible = patient.evidence.map((entry) => entry.id).sort();
            const ids = read(bite, "eligibleEvidenceIds");
            if (Array.isArray(ids)) {
                const claimed = ids.filter((id) => typeof id === "string").sort();
                if (canonicalJson(claimed) !== canonicalJson(eligible))
                    throw new Error("noRealBite must prove the complete eligible single-case evidence population");
                readCitations(eligible, "noRealBite");
            }
        }
    }
    return output;
}
