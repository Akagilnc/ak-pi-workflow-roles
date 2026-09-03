import { COLLECTOR_HOST } from "./collector-config.ts";
import type { CollectorClock, CollectorEvidenceRecord, CollectorSnapshot } from "./collector-evidence.ts";
import type { CollectorLedger, CollectorRequestAttempt } from "./collector-ledger.ts";
import {
  enrichCollectorFindings,
  extractCollectorEvidenceIdentityGroups,
  type ExtractedCollectorIdentityGroup,
} from "./collector-identity.ts";
import { validateAcceptedCollectorReceipt, type CollectorEvidenceRecord as ReceiptEvidenceRecord } from "./package-contracts/collector-output.ts";

export { validateAcceptedCollectorReceipt };

/**
 * #641 chain① receipt-local evidence projection: machine identity, integrity
 * digest and resolvable pointer fields only. Bodies/raw stay in the volume
 * (observe details + GitHub pointer); they are never transcribed into the receipt.
 */
export type CollectorReceiptEvidenceRecord = ReceiptEvidenceRecord;

export type CollectorReceipt = {
  host: "github.com";
  repository: string;
  prNumber: number;
  manifestDigest: string;
  activationTime: string;
  deadlineTime: string;
  finalObservationTime: string;
  finalSnapshotId: string;
  targetHead: string;
  groups: ExtractedCollectorIdentityGroup[];
  requestAttempts: CollectorRequestAttempt[];
  snapshots: CollectorSnapshot[];
  evidenceRecords: CollectorReceiptEvidenceRecord[];
};

function fail(message: string): never { throw new Error(message); }

/** Runtime output assembles findings pointers from the model submission into the typed receipt. */
export function buildCollectorReceipt(
  ledger: CollectorLedger,
  candidateRaw: unknown,
  clock?: CollectorClock,
): CollectorReceipt {
  ledger.assertNotFatal();
  if (ledger.outputAccepted) fail("Collector output is singleton");
  if (ledger.unresolvedTransportFailure) fail("Collector cannot output while a transport failure is unrecovered");
  if (ledger.latestCompleteSnapshotId === undefined) fail("Collector output requires a complete final snapshot");
  if (ledger.activationTime === undefined || ledger.deadlineTime === undefined) fail("Collector output requires activation timeline");

  if (clock !== undefined) ledger.assertOutputObservationLaw(clock);
  else if (ledger.observedGeneration !== ledger.mutationGeneration ||
    (ledger.finalObservationRequired && !ledger.finalObservationCompleted)) {
    fail("Collector output requires a complete observe after the latest request/wait mutation");
  }

  const finalSnapshot = ledger.getSnapshot(ledger.latestCompleteSnapshotId);
  if (finalSnapshot === undefined || !finalSnapshot.complete) fail("Collector final snapshot is incomplete");
  if (finalSnapshot.prState !== "OPEN") fail("Collector final snapshot PR state is not OPEN");

  const evidenceRecords: CollectorEvidenceRecord[] = [...ledger.allEvidence()];
  const snapshots = [...ledger.allSnapshots()];
  const evidenceIndex = new Map(evidenceRecords.map((record) => [record.evidenceId, record]));
  const snapshotIndex = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  if (evidenceIndex.size !== evidenceRecords.length) fail("Collector receipt evidenceId collision");
  if (snapshotIndex.size !== snapshots.length) fail("Collector receipt snapshotId collision");
  for (const id of evidenceIndex.keys()) if (snapshotIndex.has(id)) fail(`Collector receipt id "${id}" is ambiguous`);
  if (!snapshotIndex.has(finalSnapshot.snapshotId)) fail("Collector receipt lacks final snapshot");
  for (const snapshot of snapshots) {
    for (const id of snapshot.evidenceIds) if (!evidenceIndex.has(id)) fail(`Collector snapshot ref "${id}" does not resolve`);
  }

  const groups = extractCollectorEvidenceIdentityGroups(evidenceRecords, finalSnapshot.headOid);
  // #641 chain①: the collector LLM submits findings as pointer refs; the runtime
  // enriches each with the machine locator from the same stored record.
  enrichCollectorFindings({
    candidate: candidateRaw,
    records: evidenceRecords,
    groups,
    targetHead: finalSnapshot.headOid,
    repository: ledger.config.repository.canonical,
    prNumber: ledger.config.prNumber,
  });
  for (const group of groups) {
    if (group.attendance !== true) fail("Collector group lacks attendance");
    for (const material of group.materials) {
      if (material.evidenceId === undefined || !evidenceIndex.has(material.evidenceId)) fail("Collector material lacks a receipt-local evidence ref");
    }
    for (const finding of group.findings) {
      if (finding.source.evidenceId === undefined || !evidenceIndex.has(finding.source.evidenceId)) fail("Collector finding lacks a receipt-local evidence ref");
    }
  }

  return {
    host: COLLECTOR_HOST,
    repository: ledger.config.repository.canonical,
    prNumber: ledger.config.prNumber,
    manifestDigest: ledger.config.manifest.digest,
    activationTime: ledger.activationTime.toISOString(),
    deadlineTime: ledger.deadlineTime.toISOString(),
    finalObservationTime: finalSnapshot.completedAt ?? finalSnapshot.observedAt,
    finalSnapshotId: finalSnapshot.snapshotId,
    targetHead: finalSnapshot.headOid,
    groups,
    requestAttempts: [...ledger.requestAttempts()],
    snapshots,
    evidenceRecords: evidenceRecords.map(toReceiptEvidenceRecord),
  };
}

function toReceiptEvidenceRecord(record: CollectorEvidenceRecord): CollectorReceiptEvidenceRecord {
  return {
    evidenceId: record.evidenceId,
    kind: record.kind,
    versionId: record.versionId,
    contentDigest: record.contentDigest,
    firstObservedAt: record.firstObservedAt,
    ...(record.githubId === undefined ? {} : { githubId: record.githubId }),
    ...(record.authorLogin === undefined ? {} : { authorLogin: record.authorLogin }),
    ...(record.htmlUrl === undefined ? {} : { htmlUrl: record.htmlUrl }),
    ...(record.authoritativeTime === undefined ? {} : { authoritativeTime: record.authoritativeTime }),
  };
}
