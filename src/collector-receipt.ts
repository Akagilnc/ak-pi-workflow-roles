import { COLLECTOR_HOST } from "./collector-config.ts";
import type { CollectorClock, CollectorEvidenceRecord, CollectorSnapshot } from "./collector-evidence.ts";
import type { CollectorLedger, CollectorRequestAttempt } from "./collector-ledger.ts";
import { extractCollectorEvidenceIdentityGroups, type ExtractedCollectorIdentityGroup } from "./collector-identity.ts";
import { validateAcceptedCollectorReceipt } from "./package-contracts/collector-output.ts";

export { validateAcceptedCollectorReceipt };

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
  evidenceRecords: CollectorEvidenceRecord[];
};

function fail(message: string): never { throw new Error(message); }

/** Runtime output is intentionally empty: observed typed groups are the sole receipt source. */
export function buildCollectorReceipt(
  ledger: CollectorLedger,
  _candidateRaw: unknown,
  clock?: CollectorClock,
): CollectorReceipt {
  ledger.assertNotFatal();
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

  const evidenceRecords = [...ledger.allEvidence()];
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
    evidenceRecords,
  };
}
