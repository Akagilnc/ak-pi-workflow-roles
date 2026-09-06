import { Type } from "typebox";
import { canonicalJson } from "./canonical-json.ts";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_ACCEPTED_TEXT = "太医署回执已接受";
export const DOCTOR_ACCEPTED_AUDIT_NO_RECEIPT_TEXT = "太医署回执已接受；审计无回执";
export const DOCTOR_ACCEPTED_AUDIT_UNREADABLE_TEXT = "太医署回执已接受；审计形状不可读";
export const DOCTOR_OUTPUT_TOOL_DESCRIPTION = "提交唯一终局单案证词；completed 允许空 findings；runtime 补记派生成本入回执。";
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
export type DoctorOutput =
  | { status: "completed"; case: DoctorCaseIdentity; findings: DoctorFinding[]; cost: DoctorCaseCost }
  | Extract<DoctorSubmission, { status: "refused" }>;
export type DoctorEvidenceEntry = { id: string; kind: "session" | "stderr"; byteLength: number; contentLength: number; sha256: string; content: string };
export type DoctorCase = { version: 1; identity: DoctorCaseIdentity; evidence: DoctorEvidenceEntry[]; cost: DoctorCaseCost };

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
    status: Type.Literal("completed", { description: "completed — 形状指引，非 schema 闸；允许空 findings；runtime 补记派生成本入回执" }),
    case: Type.Unsafe({ ...caseIdentity, description: "留存太医署案身份" }),
    findings: Type.Array(finding, { description: "可空或仅含非处方案观察；缺可复用资产或 bounded-bite 证据只排除对应资产处方" }),
  }, { additionalProperties: false, description: "单案证词，不要求任何处方或可复用 finding" }),
  Type.Object({
    status: Type.Literal("refused", { description: "refused — 形状指引，非 schema 闸；仅当证据不足以支撑如实案证词" }),
    reason: Type.String({ minLength: 1, description: "证据不足以支撑如实证词的原因" }),
    missingEvidence: Type.Array(Type.Object({ need: nonblank, targetKeys: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1, description: "如实证词所需而尚缺的证据" }),
  }, { additionalProperties: false, description: "证据不足以支撑如实案证词" }),
]);
export const doctorSubmissionSchema = withInfrastructureFailureDeclaration(
  openToolObjectFromUnion(doctorSubmissionVariants),
);
export const doctorOutputSchema = Type.Union([
  Type.Object({ status: Type.Literal("completed"), case: caseIdentity, findings: Type.Array(finding), cost }, { additionalProperties: false }),
  doctorSubmissionVariants.anyOf[1]!,
]);
export const doctorEvidenceReadSchema = Type.Object({ evidenceId: Type.String({ minLength: 1, description: "待读留存证据标识" }), offset: Type.Optional(Type.Integer({ minimum: 0, description: "起始字节偏移（从 0 计）" })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "返回字节上限" })) }, { additionalProperties: false });
export class DoctorSubmissionContractError extends Error { override readonly name = "DoctorSubmissionContractError"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function read(value: unknown, key: string): unknown { if (!isRecord(value)) return undefined; try { return value[key]; } catch { return undefined; } }
export function validateDoctorSubmissionShape(value: unknown): DoctorSubmission {
  const status = read(value, "status");
  if (status !== "completed" && status !== "refused") throw new DoctorSubmissionContractError("太医署交卷无已识别的执行状态");
  return value as DoctorSubmission;
}
export function validateRecordedDoctorOutput(value: unknown): DoctorOutput {
  const output = validateDoctorSubmissionShape(value);
  const status = read(output, "status");
  if (status === "completed" && read(output, "cost") === undefined) throw new DoctorSubmissionContractError("completed 太医署回执缺少 runtime 持有的 cost 证词");
  return output as DoctorOutput;
}

export class DoctorEvidenceStore {
  readonly entries: Map<string, DoctorEvidenceEntry>; private readonly coverage = new Map<string, Array<[number, number]>>();
  constructor(readonly patient: DoctorCase) { this.entries = new Map(patient.evidence.map((entry) => [entry.id, entry])); }
  read(evidenceId: string, offset = 0, limit = 4096) { const entry = this.entries.get(evidenceId); if (!entry) throw new Error(`证据 ID 未准入：${evidenceId}`); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096) throw new Error("证据分页参数无效"); if (offset > entry.contentLength) throw new Error("证据 offset 超出内容"); const end = Math.min(entry.contentLength, offset + limit); const ranges = [...(this.coverage.get(evidenceId) ?? []), [offset, end] as [number, number]].sort((a, b) => a[0] - b[0]); const merged: Array<[number, number]> = []; for (const range of ranges) { const prior = merged.at(-1); if (prior && range[0] <= prior[1]) prior[1] = Math.max(prior[1], range[1]); else merged.push([...range]); } this.coverage.set(evidenceId, merged); return { evidenceId, kind: entry.kind, offset, content: entry.content.slice(offset, end), nextOffset: end < entry.contentLength ? end : null, contentLength: entry.contentLength, byteLength: entry.byteLength, sha256: entry.sha256 }; }
  hasRead(id: string) { const entry = this.entries.get(id); const ranges = this.coverage.get(id); return !!entry && ranges?.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === entry.contentLength; }
  readRecord() { return [...this.coverage.keys()].sort().map((evidenceId) => ({ evidenceId, fullyRead: this.hasRead(evidenceId) })); }
}
export function validateDoctorOutput(value: unknown, patient: DoctorCase, store: DoctorEvidenceStore): DoctorSubmission {
  const output = validateDoctorSubmissionShape(value);
  const lawfulTargets = new Set(["case", ...patient.cost.invocations.sources]);
  const assertTarget = (targetKey: unknown) => { if (typeof targetKey === "string" && !lawfulTargets.has(targetKey)) throw new DoctorSubmissionContractError(`targetKey 不是合法案目标：${targetKey}`); };
  const readCitations = (ids: unknown, label: string) => { if (!Array.isArray(ids)) return; for (const id of ids) if (typeof id === "string" && (!store.entries.has(id) || !store.hasRead(id))) throw new DoctorSubmissionContractError(`${label} 须引用已准入/已读证据：${id}`); };
  if (read(output, "status") === "refused") {
    const missingEvidence = read(output, "missingEvidence");
    if (Array.isArray(missingEvidence)) for (const missing of missingEvidence) {
      const targets = read(missing, "targetKeys");
      if (Array.isArray(targets)) for (const target of targets) assertTarget(target);
    }
    return output;
  }
  const identity = read(output, "case");
  const issueNumber = read(identity, "issueNumber");
  const runsPath = read(identity, "runsPath");
  if ((issueNumber !== undefined && issueNumber !== patient.identity.issueNumber) || (runsPath !== undefined && runsPath !== patient.identity.runsPath)) throw new DoctorSubmissionContractError("太医署交卷 case 须等于已激活案身份");
  const findings = read(output, "findings");
  if (!Array.isArray(findings)) return output;
  for (const finding of findings) {
    const targetKey = read(finding, "targetKey");
    readCitations(read(finding, "evidenceIds"), "finding");
    const assetEvidence = read(finding, "assetEvidence");
    if (!isRecord(assetEvidence)) { assertTarget(targetKey); continue; }
    const assetTargetKey = read(assetEvidence, "targetKey");
    const assetTargetKind = read(assetEvidence, "targetKind");
    const assetEvidenceId = read(assetEvidence, "evidenceId");
    if (typeof assetTargetKey === "string" && assetTargetKey !== targetKey) throw new DoctorSubmissionContractError("类型化资产证据须确立 finding 的 targetKey");
    if (typeof assetTargetKind === "string" && assetTargetKind !== read(finding, "targetKind")) throw new DoctorSubmissionContractError("类型化资产证据须确立 finding 的 targetKind");
    if (typeof assetEvidenceId === "string") readCitations([assetEvidenceId], "asset evidence");
    const guardrails = read(finding, "guardrails");
    for (const key of ["reproducibleFailure", "owningSeamOrInvariant", "deletionOrSimplificationSuffices"]) readCitations(read(read(guardrails, key), "evidenceIds"), "guardrail");
    const bite = read(finding, "lastRealBite");
    const biteKind = read(bite, "kind");
    if (biteKind !== "actual" && biteKind !== "noRealBite") continue;
    if (read(bite, "targetKey") !== targetKey) throw new DoctorSubmissionContractError("lastRealBite 目标不匹配");
    if (biteKind === "actual") {
      const evidenceId = read(bite, "evidenceId");
      const entry = typeof evidenceId === "string" ? store.entries.get(evidenceId) : undefined;
      if (!entry || entry.kind !== "session" || !store.hasRead(entry.id)) throw new DoctorSubmissionContractError("actual bite 须引用已准入/已读的留存 session");
    } else {
      const eligible = patient.evidence.map((entry) => entry.id).sort();
      const ids = read(bite, "eligibleEvidenceIds");
      if (Array.isArray(ids)) {
        const claimed = ids.filter((id): id is string => typeof id === "string").sort();
        if (canonicalJson(claimed) !== canonicalJson(eligible)) throw new DoctorSubmissionContractError("noRealBite 须证明完整的单案合格证据全集");
        readCitations(eligible, "noRealBite");
      }
    }
  }
  return output;
}
