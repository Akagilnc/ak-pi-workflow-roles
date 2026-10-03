import { Type } from "typebox";
import { canonicalJson } from "./canonical-json.ts";
import { openToolObject } from "./open-tool-schema.ts";
import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

import { isRecord } from "./unknown-value.ts";

export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
export const DOCTOR_OUTPUT_TOOL_DESCRIPTION = "提交唯一终局单案证词；completed 允许空 findings。";
export const DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"] as const;
export type DoctorTargetKind = typeof DOCTOR_TARGET_KINDS[number];
const DOCTOR_DISPOSITIONS = ["keep", "thin", "delete"] as const;
const DOCTOR_PRESCRIPTION_KINDS = ["retain", "delete", "simplify", "patch", "addMechanism"] as const;
const biteActual = "actual" as const;
const biteNone = "noRealBite" as const;
const DOCTOR_BITE_KINDS = [biteActual, biteNone] as const;
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
  | { kind: typeof biteActual; targetKey: string; evidenceId: string }
  | { kind: typeof biteNone; targetKey: string; eligibleEvidenceIds: string[] };
type DoctorFindingBody = {
  evidenceIds: string[]; disposition: (typeof DOCTOR_DISPOSITIONS)[number];
  guardrails: { reproducibleFailure: DoctorGuardrailAnswer; owningSeamOrInvariant: DoctorGuardrailAnswer; deletionOrSimplificationSuffices: DoctorGuardrailAnswer };
  prescription: { kind: (typeof DOCTOR_PRESCRIPTION_KINDS)[number]; recommendation: string; necessityExplanation?: string };
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
export type DoctorEvidenceEntry = { id: string; kind: "session" | "log"; byteLength: number; contentLength: number; sha256: string; content: string };
export type DoctorCase = { version: 1; identity: DoctorCaseIdentity; evidence: DoctorEvidenceEntry[]; cost: DoctorCaseCost };

// status 的合法词写在 description。交卷原样入账（validateDoctorSubmissionShape），
// 本文件不按 completed | refused 改道。case / findings / reason / missingEvidence
// 同样不按长度或嵌套改道，台院读原卷。声明只留字段名和语义说明，不留类型、嵌套、
// 枚举、长度、必填。
// The evidence-read action tool below keeps its own constraints — code reads
// evidenceId/offset/limit to look up and slice (DoctorEvidenceStore.read), which
// is a live-target binding, not a submission shape gate (ADR 0037).
const DOCTOR_STATUS_DESCRIPTION =
  "completed | refused。completed 允许空 findings；refused 仅当证据不足以支撑如实案证词" as const;
const doctorSubmissionObject = Type.Object({
  status: Type.Unknown({ description: DOCTOR_STATUS_DESCRIPTION }),
  case: Type.Unknown({
    description:
      "留存太医署案身份，原样留存（如 issueNumber、runsPath）。机械层另按绑定 run 投影案身份，不在本字段重判。",
  }),
  findings: Type.Unknown({
    description:
      `逐条资产观察与处方，原样留存。一条可含 targetKey、targetKind（${DOCTOR_TARGET_KINDS.join(" | ")}）、observation、evidenceIds、disposition（${DOCTOR_DISPOSITIONS.join(" | ")}）、assetEvidence（targetKey、targetKind、evidenceId）、guardrails（reproducibleFailure、owningSeamOrInvariant、deletionOrSimplificationSuffices，各项可含 answer、evidenceIds、explanation）、prescription（kind 为 ${DOCTOR_PRESCRIPTION_KINDS.join(" | ")}，另可写 recommendation、necessityExplanation）、lastRealBite（kind 为 ${DOCTOR_BITE_KINDS.join(" | ")}，另可写 targetKey、evidenceId、eligibleEvidenceIds）。不要求任何处方或可复用 finding；缺可复用资产或 bounded-bite 证据只排除对应资产处方。机器不核验。`,
  }),
  reason: Type.Unknown({
    description: "证据不足以支撑如实证词的原因；仅 refused 时用。",
  }),
  missingEvidence: Type.Unknown({
    description: "如实证词所需而尚缺的证据，原样留存（如每项 need、targetKeys）。",
  }),
});
export const doctorSubmissionSchema = withTerminatingOutputDeclarations(
  openToolObject(doctorSubmissionObject),
);
// #836 r16 class 3: action tool — code reads evidenceId to look up the Map entry
// and offset/limit to slice + accumulate coverage (DoctorEvidenceStore.read);
// those constraints stay. Root additionalProperties:false is deleted — no reader
// consumes extra fields, so a closed object only rejects the role for saying more.
export const doctorEvidenceReadSchema = Type.Object({ evidenceId: Type.String({ minLength: 1, description: "待读留存证据标识" }), offset: Type.Optional(Type.Integer({ minimum: 0, description: "起始字节偏移（从 0 计）" })), limit: Type.Optional(Type.Integer({ minimum: 1, description: "返回字节数（无上限）" })) }, { additionalProperties: true });
export class DoctorSubmissionContractError extends Error { override readonly name = "DoctorSubmissionContractError"; }

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
 * Judge/台院 read the original volume.
 */
export function validateDoctorOutput(value: unknown, _patient: DoctorCase, _store: DoctorEvidenceStore): DoctorSubmission {
  return validateDoctorSubmissionShape(value);
}
