import { Type } from "typebox";
import { canonicalJson } from "./canonical-json.ts";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_ACCEPTED_TEXT = "太医署回执已接受";
export const DOCTOR_ACCEPTED_AUDIT_NO_RECEIPT_TEXT = "太医署回执已接受；审计无回执";
export const DOCTOR_OUTPUT_TOOL_DESCRIPTION = "提交唯一终局单案证词；completed 允许空 findings。";
export const DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"] as const;
export type DoctorTargetKind = typeof DOCTOR_TARGET_KINDS[number];
export type DoctorCaseIdentity = { issueNumber: number; runsPath: string };
export type DoctorSessionCost =
  | { source: string; startedAt: string; endedAt: string; wallMilliseconds: number; completion: "accepted" }
  | { source: string; startedAt?: string; endedAt?: string; wallMilliseconds?: number; completion: "incomplete"; degradationReason?: string };
export type DoctorCount = { count: number; sources: string[] };
export type DoctorCaseCost = {
  invocations: DoctorCount; legs: DoctorCount; modelApiTurns: DoctorCount; outputTokens: DoctorCount; toolCalls: DoctorCount;
  retries: DoctorCount & { evidence: "literal run-dir naming" };
  statuses: Array<{ source: string; status: string }>;
  commits: Array<{ source: string; commit: string }>;
  sessions: DoctorSessionCost[];
  outputBytes: DoctorCount & { payload: "raw JSONL bytes"; providerWireBytes: "unavailable" };
};
export type DoctorGuardrailAnswer = { answer: boolean; evidenceIds: string[]; explanation: string };
export type DoctorLastRealBite =
  | { kind: "actual"; targetKey: string; evidenceId: string }
  | { kind: "noRealBite"; targetKey: string; eligibleEvidenceIds: string[] };
type DoctorFindingBody = {
  evidenceIds: string[]; disposition: "keep" | "thin" | "delete";
  guardrails: { reproducibleFailure: DoctorGuardrailAnswer; owningSeamOrInvariant: DoctorGuardrailAnswer; deletionOrSimplificationSuffices: DoctorGuardrailAnswer };
  prescription: { kind: "retain" | "delete" | "simplify" | "patch" | "addMechanism"; recommendation: string; necessityExplanation?: string };
  lastRealBite: DoctorLastRealBite;
};
type DoctorAssetKind = DoctorTargetKind;
export type DoctorFinding =
  | { targetKey: string; observation: string; evidenceIds: string[] }
  | (DoctorFindingBody & { targetKey: string; targetKind: DoctorAssetKind; assetEvidence: { targetKey: string; targetKind: DoctorAssetKind; evidenceId: string } });
export type DoctorSubmission =
  | { status: "completed"; case: DoctorCaseIdentity; findings: DoctorFinding[] }
  | { status: "refused"; reason: string; missingEvidence: Array<{ need: string; targetKeys: string[] }> };
// #836: runtime cost is a fact beside the role payload, never merged into it —
// DoctorOutput is the accepted payload itself, identical to DoctorSubmission.
export type DoctorOutput = DoctorSubmission;
export type DoctorEvidenceEntry = { id: string; kind: "session" | "stderr"; byteLength: number; contentLength: number; sha256: string; content: string };
export type DoctorCase = { version: 1; identity: DoctorCaseIdentity; evidence: DoctorEvidenceEntry[]; cost: DoctorCaseCost };

// #836 r16 class 1: case/finding/assetEvidence/guardrails/prescription/
// lastRealBite/missingEvidence are LLM/human-read narrative content — Judge/
// 察院 read the original volume, no code branches on their length or nested
// presence (src/doctor-contracts.ts:136-138 passes the submission through
// unprojected). Field/type/description/Literal value stay; provider
// required/minLength/minItems/minimum/nested additionalProperties:false is deleted.
const nonblank = Type.Optional(Type.String());
const evidenceIds = Type.Optional(Type.Array(Type.String()));
const guardrail = Type.Object({ answer: Type.Optional(Type.Boolean()), evidenceIds, explanation: nonblank }, { additionalProperties: true });
const lastRealBite = Type.Union([
  Type.Object({ kind: Type.Optional(Type.Literal("actual")), targetKey: nonblank, evidenceId: nonblank }, { additionalProperties: true }),
  Type.Object({ kind: Type.Optional(Type.Literal("noRealBite")), targetKey: nonblank, eligibleEvidenceIds: evidenceIds }, { additionalProperties: true }),
]);
const assetKinds = DOCTOR_TARGET_KINDS;
const findingBody = {
  evidenceIds, disposition: Type.Optional(Type.Union([Type.Literal("keep"), Type.Literal("thin"), Type.Literal("delete")])),
  guardrails: Type.Optional(Type.Object({ reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: guardrail }, { additionalProperties: true })),
  prescription: Type.Optional(Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("retain"), Type.Literal("delete"), Type.Literal("simplify"), Type.Literal("patch"), Type.Literal("addMechanism")])), recommendation: nonblank, necessityExplanation: nonblank }, { additionalProperties: true })), lastRealBite: Type.Optional(lastRealBite),
};
const finding = Type.Union([
  Type.Object({ targetKey: nonblank, observation: nonblank, evidenceIds }, { additionalProperties: true }),
  Type.Object({ targetKey: nonblank, targetKind: Type.Optional(Type.Union(assetKinds.map((kind) => Type.Literal(kind)))), assetEvidence: Type.Optional(Type.Object({ targetKey: nonblank, targetKind: Type.Optional(Type.Union(assetKinds.map((kind) => Type.Literal(kind)))), evidenceId: nonblank }, { additionalProperties: true })), ...findingBody }, { additionalProperties: true }),
]);
const caseIdentity = Type.Object({ issueNumber: Type.Optional(Type.Integer()), runsPath: nonblank }, { additionalProperties: true });
const doctorSubmissionVariants = Type.Union([
  Type.Object({
    status: Type.Literal("completed", { description: "completed — 形状指引，非 schema 闸；允许空 findings" }),
    case: Type.Unsafe({ ...caseIdentity, description: "留存太医署案身份" }),
    findings: Type.Array(finding, { description: "可空或仅含非处方案观察；缺可复用资产或 bounded-bite 证据只排除对应资产处方" }),
  }, { additionalProperties: false, description: "单案证词，不要求任何处方或可复用 finding" }),
  Type.Object({
    status: Type.Literal("refused", { description: "refused — 形状指引，非 schema 闸；仅当证据不足以支撑如实案证词" }),
    reason: Type.String({ description: "证据不足以支撑如实证词的原因" }),
    missingEvidence: Type.Array(Type.Object({ need: nonblank, targetKeys: evidenceIds }, { additionalProperties: true }), { description: "如实证词所需而尚缺的证据" }),
  }, { additionalProperties: false, description: "证据不足以支撑如实案证词" }),
]);
export const doctorSubmissionSchema = withInfrastructureFailureDeclaration(
  openToolObjectFromUnion(doctorSubmissionVariants),
);
// #836 r16 class 3: action tool — code reads evidenceId to look up the Map entry
// and offset/limit to slice + accumulate coverage (src/doctor-contracts.ts:97-128,
// src/doctor-role.ts:38); those constraints stay. Root additionalProperties:false
// is deleted — no reader consumes extra fields, so a closed object only rejects
// the role for saying more (src/doctor-role.ts execute reads named params only).
export const doctorEvidenceReadSchema = Type.Object({ evidenceId: Type.String({ minLength: 1, description: "待读留存证据标识" }), offset: Type.Optional(Type.Integer({ minimum: 0, description: "起始字节偏移（从 0 计）" })), limit: Type.Optional(Type.Integer({ minimum: 1, description: "返回字节数（无上限）" })) }, { additionalProperties: true });
export class DoctorSubmissionContractError extends Error { override readonly name = "DoctorSubmissionContractError"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function read(value: unknown, key: string): unknown { if (!isRecord(value)) return undefined; try { return value[key]; } catch { return undefined; } }
export function validateDoctorSubmissionShape(value: unknown): DoctorSubmission {
  return value as DoctorSubmission;
}
export function validateRecordedDoctorOutput(value: unknown): DoctorOutput {
  return value as DoctorOutput;
}

export class DoctorEvidenceStore {
  readonly entries: Map<string, DoctorEvidenceEntry>; private readonly coverage = new Map<string, Array<[number, number]>>();
  constructor(readonly patient: DoctorCase) { this.entries = new Map(patient.evidence.map((entry) => [entry.id, entry])); }
  // #836 A6.5: no 4096 hard cap — limit only bounds the requested window when provided.
  read(evidenceId: string, offset = 0, limit?: number) {
    const entry = this.entries.get(evidenceId);
    if (!entry) throw new Error(`证据 ID 未准入：${evidenceId}`);
    if (!Number.isInteger(offset) || offset < 0) throw new Error("证据分页参数无效");
    if (offset > entry.contentLength) throw new Error("证据 offset 超出内容");
    const window = limit === undefined
      ? entry.contentLength - offset
      : (!Number.isInteger(limit) || limit < 1 ? (() => { throw new Error("证据分页参数无效"); })() : limit);
    const end = Math.min(entry.contentLength, offset + window);
    const ranges = [...(this.coverage.get(evidenceId) ?? []), [offset, end] as [number, number]].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const prior = merged.at(-1);
      if (prior && range[0] <= prior[1]) prior[1] = Math.max(prior[1], range[1]);
      else merged.push([...range]);
    }
    this.coverage.set(evidenceId, merged);
    return {
      evidenceId,
      kind: entry.kind,
      offset,
      content: entry.content.slice(offset, end),
      nextOffset: end < entry.contentLength ? end : null,
      contentLength: entry.contentLength,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    };
  }
  hasRead(id: string) { const entry = this.entries.get(id); const ranges = this.coverage.get(id); return !!entry && ranges?.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === entry.contentLength; }
  readRecord() { return [...this.coverage.keys()].sort().map((evidenceId) => ({ evidenceId, fullyRead: this.hasRead(evidenceId) })); }
}
/**
 * #836: cross-check rejection deleted (2.6). Shape guidance only — code does not
 * re-verify evidence citations, case identity, or bite completeness against the store.
 * Judge/察院 read the original volume.
 */
export function validateDoctorOutput(value: unknown, _patient: DoctorCase, _store: DoctorEvidenceStore): DoctorSubmission {
  return validateDoctorSubmissionShape(value);
}
