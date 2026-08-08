import type { ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";

export type ReviewerAuditMaterialFact = Readonly<{
  axis: "standards" | "spec";
  manifestSha256: string;
  readableEntries: readonly Readonly<{ id: string; relativeClonePath: string; utf8Length: number; sha256: string }>[];
  reportPresent: boolean;
  coverageMustBeJudgedFromReport: true;
}>;

export type ReviewerAuditReadiness = Readonly<{
  ready: boolean;
  missing: readonly string[];
  materials: readonly ReviewerAuditMaterialFact[];
}>;

/**
 * Projects only runtime-observed material access and report-presence facts.
 * Coverage remains the auditor's semantic judgment; this function never parses
 * report prose or treats a presentation heading as evidence.
 */
export function reviewerAuditReadiness(record: ReviewerExecutionRecord): ReviewerAuditReadiness {
  const accepted = record.accepted;
  if (accepted === undefined || !Array.isArray(accepted.materials) || !Array.isArray(accepted.bundle?.entries)) {
    return Object.freeze({ ready: true, missing: Object.freeze([]), materials: Object.freeze([]) });
  }
  const missing: string[] = [];
  for (const material of accepted.materials) {
    if (material.source === undefined || material.sourcePath === undefined) missing.push(`material ${material.id}: typed source path`);
  }
  const facts: ReviewerAuditMaterialFact[] = [];
  for (const axis of ["standards", "spec"] as const) {
    const result = record.results[axis];
    if (result === undefined) continue;
    if (result.status !== "successful") {
      facts.push(Object.freeze({ axis, manifestSha256: accepted.bundle.manifestSha256, readableEntries: Object.freeze([]), reportPresent: false, coverageMustBeJudgedFromReport: true }));
      continue;
    }
    const evidence = result.runtimeConstructionEvidence;
    if (evidence === undefined) {
      missing.push(`${axis}: runtime materialization evidence`);
      continue;
    }
    if (evidence.leg !== axis) missing.push(`${axis}: materialization axis`);
    if (evidence.manifestSha256 !== accepted.bundle.manifestSha256) missing.push(`${axis}: bundle manifest binding`);
    const readableEntries = evidence.entries.filter((entry) => entry.verified === true && entry.readable === true).map(({ id, relativeClonePath, utf8Length, sha256 }) => ({ id, relativeClonePath, utf8Length, sha256 }));
    if (readableEntries.length !== accepted.bundle.entries.length) missing.push(`${axis}: every bundle entry readable`);
    for (const entry of accepted.bundle.entries) {
      const actual = evidence.entries.find((candidate) => candidate.id === entry.id);
      if (actual === undefined || actual.relativeClonePath !== entry.relativeClonePath || actual.utf8Length !== entry.utf8Length || actual.sha256 !== entry.sha256 || actual.verified !== true || actual.readable !== true) missing.push(`${axis}: ${entry.id} bytes and path binding`);
    }
    if (result.report.trim().length === 0) missing.push(`${axis}: non-empty report`);
    facts.push(Object.freeze({ axis, manifestSha256: evidence.manifestSha256, readableEntries: Object.freeze(readableEntries), reportPresent: result.report.trim().length > 0, coverageMustBeJudgedFromReport: true }));
  }
  return Object.freeze({ ready: missing.length === 0, missing: Object.freeze([...new Set(missing)]), materials: Object.freeze(facts) });
}
