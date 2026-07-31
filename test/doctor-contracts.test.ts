import assert from "node:assert/strict";
import test from "node:test";

import { DoctorEvidenceStore, statsLineEvidenceBytes, validateDoctorEvidenceIndex, validateDoctorOutput, validateRecordedDoctorOutput } from "../src/doctor-contracts.ts";
import { sha256Hex } from "../src/sha256.ts";
import type { StatsLineV1 } from "../src/stats-line.ts";

const target = " Gate/Exact Byte ";
function line(issueNumber: number): StatsLineV1 { return { version: 1, caseKey: { repository: "ak/repo", issueNumber }, source: { targetCommit: String(issueNumber).repeat(40).slice(0, 40), manifests: [] }, recordedInvocations: { status: "measured", value: { total: 0, byRole: { judge: 0, fixer: 0, coder: 0, reviewer: 0, collector: 0, doctor: 0 }, unclassified: 0 } }, judgeContinueCount: { status: "measured", value: 0 }, auditRejectionCount: { status: "unavailable", reason: "recorder-records-only-accepted-audits" }, recordedInvocationWindow: { status: "unavailable", reason: "recorder-does-not-record-invocation-timestamps" }, issueToDefaultMerge: { status: "unavailable", reason: "tracker-metadata-invalid" }, paperApplyBytes: { status: "measured", value: { paperBytes: 0, applyBytes: 0, ratio: { status: "unavailable", reason: "no-apply-receipts" } } }, paperApplyWallClock: { status: "unavailable", reason: "recorder-does-not-record-wall-clock" } }; }
function entry(id: string, kind: string, data: unknown, source = false) { const bytes = statsLineEvidenceBytes(data); return { id, kind, sha256: sha256Hex(bytes), byteLength: bytes.byteLength, ...(source ? { source: { commit: "a".repeat(40), path: `.ak/dockets/${id}.json` } } : {}), data }; }
function index() { return validateDoctorEvidenceIndex({ version: 1, repository: "ak/repo", targetCommit: "a".repeat(40), catalog: [{ key: target, kind: "gate", active: true }], populations: [{ id: "bounded", targetKey: target, eligibleEvidenceIds: ["bite"] }], evidence: [entry("bite", "receipt", { blocked: true }, true), entry("stats-1", "statsLine", line(1)), entry("stats-2", "statsLine", line(2))] }); }
function completed(lastRealBite: unknown, disposition = "thin") { const unavailable = { status: "unavailable", reason: "recorder-records-only-accepted-audits" }; return { status: "completed", coverage: [{ targetKey: target, evidenceIds: ["bite"] }], trends: [{ metric: "auditRejectionCount", points: [{ evidenceId: "stats-1", value: unavailable }, { evidenceId: "stats-2", value: unavailable }] }], findings: [{ targetKey: target, evidenceIds: ["bite"], disposition, guardrails: { reproducibleFailure: { answer: true, evidenceIds: ["bite"], explanation: "The admitted receipt records the block." }, owningSeamOrInvariant: { answer: true, evidenceIds: ["bite"], explanation: "The catalog identifies the owning gate." }, deletionOrSimplificationSuffices: { answer: true, evidenceIds: ["bite"], explanation: "Thinning restores health." } }, prescription: disposition === "keep" ? { kind: "retain", recommendation: "Retain it." } : { kind: "simplify", recommendation: "Thin it." }, lastRealBite }] };
}
function readRequired(store: DoctorEvidenceStore) { for (const id of ["bite", "stats-1", "stats-2"]) store.read(id, 0, 4096); }

test("Doctor validates actual citations and preserves catalog target bytes exactly", () => {
  const admitted = index(); const store = new DoctorEvidenceStore(admitted); readRequired(store); const bite = admitted.evidence[0]!;
  const output = completed({ kind: "actual", targetKey: target, evidenceId: "bite", sealedIdentity: { ...bite.source!, sha256: bite.sha256 } }, "keep");
  assert.deepEqual(validateDoctorOutput(output, admitted, store), output);
  assert.throws(() => validateDoctorOutput({ ...output, coverage: [{ targetKey: target.trim(), evidenceIds: ["bite"] }] }, admitted, store), /coverage target mismatch/);
});

test("Doctor noRealBite is complete, fully read, and permits only thin/delete", () => {
  const admitted = index(); const store = new DoctorEvidenceStore(admitted); readRequired(store);
  const proof = { kind: "noRealBite", targetKey: target, populationId: "bounded", eligibleEvidenceIds: ["bite"] };
  assert.equal(validateDoctorOutput(completed(proof), admitted, store).status, "completed");
  assert.throws(() => validateDoctorOutput(completed(proof, "keep"), admitted, store), /permits only thin or delete/);
  assert.throws(() => validateDoctorOutput(completed({ ...proof, eligibleEvidenceIds: [] }), admitted, store), /complete eligible population/);
  const unread = new DoctorEvidenceStore(admitted); unread.read("stats-1"); unread.read("stats-2");
  assert.throws(() => validateDoctorOutput(completed(proof), admitted, unread), /admitted\/read|fully read/);
});

test("Doctor completed/refused states are exclusive and trends exactly join distinct StatsLines", () => {
  const admitted = index(); const store = new DoctorEvidenceStore(admitted); readRequired(store);
  assert.deepEqual(validateDoctorOutput({ status: "refused", reason: "No cross-case population was admitted.", missingEvidence: [{ need: "another closed case", targetKeys: [target] }] }, admitted, store).status, "refused");
  assert.throws(() => validateDoctorOutput({ status: "refused", reason: "x", missingEvidence: [{ need: "x", targetKeys: [target] }], findings: [] }, admitted, store), /closed contract/);
  const output = completed({ kind: "noRealBite", targetKey: target, populationId: "bounded", eligibleEvidenceIds: ["bite"] }) as any;
  output.trends[0].points[0].value = { status: "measured", value: 0 };
  assert.throws(() => validateDoctorOutput(output, admitted, store), /exactly join/);
});

test("Doctor output structure is schema-owned before contextual joins", () => {
  assert.throws(() => validateRecordedDoctorOutput({ status: "refused", reason: "   ", missingEvidence: [] }), /closed contract/);
  const admitted = index(); const store = new DoctorEvidenceStore(admitted);
  assert.throws(() => validateDoctorOutput({ status: "refused", reason: "Evidence is incomplete.", missingEvidence: [{ need: "another case", targetKeys: ["unknown-target"] }] }, admitted, store), /target mismatch/);
});

test("Doctor intake rejects forbidden evidence kinds, digest drift, duplicate identities, and malformed StatsLines", () => {
  const base: any = index();
  assert.throws(() => validateDoctorEvidenceIndex({ ...base, evidence: [...base.evidence, entry("session", "session", {}, false)] }), /Forbidden or unknown/);
  assert.throws(() => validateDoctorEvidenceIndex({ ...base, evidence: [{ ...base.evidence[0], data: { changed: true } }, ...base.evidence.slice(1)] }), /digest mismatch/);
  assert.throws(() => validateDoctorEvidenceIndex({ ...base, evidence: [...base.evidence, base.evidence[0]] }), /Duplicate evidence/);
  const malformed = structuredClone(line(3)) as any;
  malformed.paperApplyBytes.value.ratio = { status: "measured", value: { numerator: 1, denominator: 0 } };
  assert.throws(() => validateDoctorEvidenceIndex({ ...base, evidence: [...base.evidence.slice(0, 1), entry("stats-bad", "statsLine", malformed)] }), /invalid StatsLine evidence/);
});
