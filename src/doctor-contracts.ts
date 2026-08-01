import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalJson } from "./canonical-json.ts";

export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"] as const;
export type DoctorTargetKind = typeof DOCTOR_TARGET_KINDS[number];
export type DoctorCaseIdentity = { issueNumber: number; runsPath: string };
export type DoctorSessionCost = { source: string; startedAt: string; endedAt: string; wallMilliseconds: number; completion: "accepted" | "incomplete" };
type Count = { count: number; sources: string[] };
export type DoctorCaseCost = {
  invocations: Count; legs: Count; modelApiTurns: Count; outputTokens: Count; toolCalls: Count;
  retries: Count & { evidence: "literal run-dir naming" };
  statuses: Array<{ source: string; status: string }>;
  commits: Array<{ source: string; commit: string }>;
  sessions: DoctorSessionCost[];
  outputBytes: Count & { payload: "raw JSONL bytes"; providerWireBytes: "unavailable" };
};
export type DoctorGuardrailAnswer = { answer: boolean; evidenceIds: string[]; explanation: string };
export type DoctorLastRealBite =
  | { kind: "actual"; targetKey: string; evidenceId: string }
  | { kind: "noRealBite"; targetKey: string; eligibleEvidenceIds: string[] };
export type DoctorFinding = {
  targetKey: string; targetKind: DoctorTargetKind; evidenceIds: string[]; disposition: "keep" | "thin" | "delete";
  guardrails: { reproducibleFailure: DoctorGuardrailAnswer; owningSeamOrInvariant: DoctorGuardrailAnswer; deletionOrSimplificationSuffices: DoctorGuardrailAnswer };
  prescription: { kind: "retain" | "delete" | "simplify" | "patch" | "addMechanism"; recommendation: string; necessityExplanation?: string };
  lastRealBite: DoctorLastRealBite;
};
export type DoctorOutput =
  | { status: "completed"; case: DoctorCaseIdentity; cost: DoctorCaseCost; findings: DoctorFinding[] }
  | { status: "refused"; reason: string; missingEvidence: Array<{ need: string; targetKeys: string[] }> };
export type DoctorEvidenceEntry = { id: string; kind: "session" | "stderr"; byteLength: number; sha256: string; content: string };
export type DoctorCase = { version: 1; identity: DoctorCaseIdentity; evidence: DoctorEvidenceEntry[]; cost: DoctorCaseCost };

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const count = Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank) }, { additionalProperties: false });
const evidenceIds = Type.Array(nonblank, { minItems: 1 });
const guardrail = Type.Object({ answer: Type.Boolean(), evidenceIds, explanation: nonblank }, { additionalProperties: false });
const lastRealBite = Type.Union([
  Type.Object({ kind: Type.Literal("actual"), targetKey: nonblank, evidenceId: nonblank }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("noRealBite"), targetKey: nonblank, eligibleEvidenceIds: evidenceIds }, { additionalProperties: false }),
]);
const finding = Type.Object({
  targetKey: nonblank, targetKind: Type.Union(DOCTOR_TARGET_KINDS.map((kind) => Type.Literal(kind))), evidenceIds,
  disposition: Type.Union([Type.Literal("keep"), Type.Literal("thin"), Type.Literal("delete")]),
  guardrails: Type.Object({ reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: guardrail }, { additionalProperties: false }),
  prescription: Type.Object({ kind: Type.Union([Type.Literal("retain"), Type.Literal("delete"), Type.Literal("simplify"), Type.Literal("patch"), Type.Literal("addMechanism")]), recommendation: nonblank, necessityExplanation: Type.Optional(nonblank) }, { additionalProperties: false }),
  lastRealBite,
}, { additionalProperties: false });
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
export function validateRecordedDoctorOutput(value: unknown): DoctorOutput { if (!Value.Check(doctorOutputSchema, value)) throw new Error("Doctor output does not match its closed contract"); return value as DoctorOutput; }

export class DoctorEvidenceStore {
  readonly entries: Map<string, DoctorEvidenceEntry>; private readonly coverage = new Map<string, Array<[number, number]>>();
  constructor(readonly patient: DoctorCase) { this.entries = new Map(patient.evidence.map((entry) => [entry.id, entry])); }
  read(evidenceId: string, offset = 0, limit = 4096) { const entry = this.entries.get(evidenceId); if (!entry) throw new Error(`Evidence ID is not admitted: ${evidenceId}`); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096) throw new Error("Invalid evidence pagination"); if (offset > entry.content.length) throw new Error("Evidence offset exceeds content"); const end = Math.min(entry.content.length, offset + limit); const ranges = [...(this.coverage.get(evidenceId) ?? []), [offset, end] as [number, number]].sort((a, b) => a[0] - b[0]); const merged: Array<[number, number]> = []; for (const range of ranges) { const prior = merged.at(-1); if (prior && range[0] <= prior[1]) prior[1] = Math.max(prior[1], range[1]); else merged.push([...range]); } this.coverage.set(evidenceId, merged); return { evidenceId, kind: entry.kind, offset, content: entry.content.slice(offset, end), nextOffset: end < entry.content.length ? end : null, byteLength: entry.byteLength, sha256: entry.sha256 }; }
  hasRead(id: string) { const entry = this.entries.get(id); const ranges = this.coverage.get(id); return !!entry && ranges?.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === entry.content.length; }
  readRecord() { return [...this.coverage.keys()].sort().map((evidenceId) => ({ evidenceId, fullyRead: this.hasRead(evidenceId) })); }
}
export function validateDoctorOutput(value: unknown, patient: DoctorCase, store: DoctorEvidenceStore): DoctorOutput {
  const output = validateRecordedDoctorOutput(value);
  const lawfulTargets = new Set(["case", ...patient.cost.invocations.sources]);
  const assertTargets = (targetKeys: string[]) => { for (const targetKey of targetKeys) if (!lawfulTargets.has(targetKey)) throw new Error(`Target key is not a lawful case target: ${targetKey}`); };
  if (output.status === "refused") { for (const missing of output.missingEvidence) assertTargets(missing.targetKeys); return output; }
  if (canonicalJson(output.case) !== canonicalJson(patient.identity) || canonicalJson(output.cost) !== canonicalJson(patient.cost)) throw new Error("Every reported number must equal the re-derived session-byte cost");
  for (const finding of output.findings) if (finding.targetKey !== "case") throw new Error("A reusable-asset target requires typed asset evidence");
  const readCitations = (ids: string[], label: string) => { for (const id of ids) if (!store.entries.has(id) || !store.hasRead(id)) throw new Error(`${label} must cite admitted/read evidence: ${id}`); };
  for (const finding of output.findings) {
    assertTargets([finding.targetKey]);
    readCitations(finding.evidenceIds, "finding");
    for (const answer of Object.values(finding.guardrails)) readCitations(answer.evidenceIds, "guardrail");
    const needsNecessity = finding.prescription.kind === "patch" || finding.prescription.kind === "addMechanism";
    if (needsNecessity !== (finding.prescription.necessityExplanation !== undefined)) throw new Error("patch/addMechanism alone require a necessity explanation");
    if (finding.lastRealBite.targetKey !== finding.targetKey) throw new Error("lastRealBite target mismatch");
    if (finding.lastRealBite.kind === "actual") {
      const entry = store.entries.get(finding.lastRealBite.evidenceId);
      if (!entry || entry.kind !== "session" || !store.hasRead(entry.id)) throw new Error("actual bite must cite an admitted/read retained session");
    } else {
      if (finding.disposition === "keep") throw new Error("noRealBite permits only thin or delete");
      const eligible = patient.evidence.map((entry) => entry.id).sort();
      const claimed = [...finding.lastRealBite.eligibleEvidenceIds].sort();
      if (canonicalJson(claimed) !== canonicalJson(eligible)) throw new Error("noRealBite must prove the complete eligible single-case evidence population");
      readCitations(eligible, "noRealBite");
    }
  }
  return output;
}
