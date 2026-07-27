import {
  COLLECTOR_HOST,
  type CollectorManifest,
  type CollectorRepository,
} from "./collector-config.ts";
import {
  COLLECTOR_RECEIPT_MAX_BYTES,
  computeWindowRelation,
  isValidReviewState,
  reviewQualifiesForValid,
  type CollectorEvidenceRecord,
  type CollectorSnapshot,
  type HeadRelation,
  type WindowRelation,
} from "./collector-evidence.ts";
import type {
  CollectorLedger,
  CollectorRequestAttempt,
} from "./collector-ledger.ts";

export type CollectorLegStatus = "valid" | "unavailable" | "missing";

export type CollectorUnavailableScope =
  | { kind: "target" }
  | { kind: "global" };

export type CollectorLegCandidate = {
  legId: string;
  status: CollectorLegStatus;
  rationale: string;
  evidenceRefs: string[];
  unavailableScope?: "target" | "global";
};

export type CollectorOutputCandidate = {
  legs: CollectorLegCandidate[];
};

export type ReviewDerivedReport = {
  kind: "review";
  legId: string;
  report: string;
  reviewedHead: string;
  headRelation: HeadRelation;
  windowRelation: WindowRelation;
  evidenceRefs: string[];
};

export type TerminalFactReport = {
  kind: "terminal-fact";
  legId: string;
  terminalStatus: "unavailable" | "missing";
  report: string;
  windowRelation: WindowRelation;
  evidenceRefs: string[];
  targetSnapshotHead?: string;
  scope?: "global";
};

export type CollectorReport = ReviewDerivedReport | TerminalFactReport;

export type CollectorReceipt = {
  host: "github.com";
  repository: string;
  prNumber: number;
  manifestVersion: 1;
  manifestDigest: string;
  activationTime: string;
  deadlineTime: string;
  finalObservationTime: string;
  finalSnapshotId: string;
  targetHead: string;
  reports: CollectorReport[];
  legs: Array<{
    legId: string;
    status: CollectorLegStatus;
    rationale: string;
    evidenceRefs: string[];
  }>;
  requestAttempts: CollectorRequestAttempt[];
  snapshots: CollectorSnapshot[];
  evidenceRecords: CollectorEvidenceRecord[];
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCollectorOutputCandidate(
  raw: unknown,
): CollectorOutputCandidate {
  if (!isRecord(raw) || !Array.isArray(raw["legs"])) {
    fail("Collector output requires a legs array");
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "legs") {
    fail("Collector output accepts only the legs field");
  }
  const legs: CollectorLegCandidate[] = [];
  for (const entry of raw["legs"]) {
    if (!isRecord(entry)) fail("Collector output leg must be an object");
    const legId = entry["legId"];
    const status = entry["status"];
    const rationale = entry["rationale"];
    const evidenceRefs = entry["evidenceRefs"];
    if (typeof legId !== "string" || legId.length === 0) {
      fail("Collector output legId must be a non-empty string");
    }
    if (status !== "valid" && status !== "unavailable" && status !== "missing") {
      fail(`Collector output status for \"${legId}\" must be valid|unavailable|missing`);
    }
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
      fail(`Collector output rationale for \"${legId}\" must be non-blank`);
    }
    if (
      !Array.isArray(evidenceRefs) ||
      evidenceRefs.length === 0 ||
      evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
    ) {
      fail(`Collector output evidenceRefs for \"${legId}\" must be a non-empty string array`);
    }
    const candidate: CollectorLegCandidate = {
      legId,
      status,
      rationale,
      evidenceRefs: evidenceRefs as string[],
    };
    if (status === "unavailable") {
      const scope = entry["unavailableScope"];
      if (scope !== "target" && scope !== "global") {
        fail(
          `Collector unavailable leg \"${legId}\" requires unavailableScope target|global`,
        );
      }
      candidate.unavailableScope = scope;
    } else if (Object.hasOwn(entry, "unavailableScope")) {
      fail(
        `Collector leg \"${legId}\" may only declare unavailableScope when status is unavailable`,
      );
    }
    // Reject unknown fields beyond the allowed set
    const allowed = new Set([
      "legId",
      "status",
      "rationale",
      "evidenceRefs",
      ...(candidate.unavailableScope === undefined ? [] : ["unavailableScope"]),
    ]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        fail(`Collector output leg \"${legId}\" has unknown field \"${key}\"`);
      }
    }
    legs.push(candidate);
  }
  return { legs };
}

function reviewInlineText(
  ledger: CollectorLedger,
  review: CollectorEvidenceRecord,
  snapshot: CollectorSnapshot,
): string {
  const inline = snapshot.evidenceIds
    .map((id) => ledger.getEvidence(id))
    .filter((record): record is CollectorEvidenceRecord =>
      record !== undefined &&
      record.kind === "review_comment" &&
      record.pullRequestReviewId !== undefined &&
      record.pullRequestReviewId !== null &&
      review.stableGitHubId === `review:${record.pullRequestReviewId}`
    );
  if (inline.length === 0) return "";
  return inline
    .map((comment) => {
      const loc = [
        comment.path ?? "?",
        comment.line === null || comment.line === undefined ? "?" : String(comment.line),
      ].join(":");
      return `- ${loc}: ${comment.body ?? ""}`;
    })
    .join("\n");
}

function factualNonFindingReport(review: CollectorEvidenceRecord): string {
  return [
    "Runtime factual non-finding record:",
    `review stable id: ${review.stableGitHubId ?? review.evidenceId}`,
    `author: ${review.authorLogin ?? "unknown"}`,
    `submitted_at: ${review.authoritativeTime ?? "unknown"}`,
    `reviewed head: ${review.commitOid ?? "unknown"}`,
    "body: blank",
    "inline comments: 0",
  ].join("\n");
}

function buildReviewReport(input: {
  legId: string;
  review: CollectorEvidenceRecord;
  ledger: CollectorLedger;
  snapshot: CollectorSnapshot;
  targetHead: string;
  activationTime: Date;
  deadlineTime: Date;
}): ReviewDerivedReport {
  const inline = reviewInlineText(input.ledger, input.review, input.snapshot);
  const body = input.review.body ?? "";
  const report = body.trim().length === 0 && inline.length === 0
    ? factualNonFindingReport(input.review)
    : [
      body.trim().length === 0 ? "(empty review body)" : body,
      inline.length === 0 ? "" : "Inline comments:",
      inline,
    ].filter((part) => part.length > 0).join("\n");

  const reviewedHead = input.review.commitOid ?? "";
  const headRelation: HeadRelation =
    reviewedHead === input.targetHead ? "current" : "prior";
  const windowRelation = computeWindowRelation(
    input.review.authoritativeTime,
    input.activationTime,
    input.deadlineTime,
  );
  const evidenceRefs = [input.review.evidenceId];
  for (const id of input.snapshot.evidenceIds) {
    const record = input.ledger.getEvidence(id);
    if (
      record?.kind === "review_comment" &&
      record.pullRequestReviewId !== undefined &&
      record.pullRequestReviewId !== null &&
      input.review.stableGitHubId === `review:${record.pullRequestReviewId}`
    ) {
      evidenceRefs.push(record.evidenceId);
    }
  }
  return {
    kind: "review",
    legId: input.legId,
    report,
    reviewedHead,
    headRelation,
    windowRelation,
    evidenceRefs,
  };
}

function collectSubstantiveReviewReports(input: {
  ledger: CollectorLedger;
  finalSnapshot: CollectorSnapshot;
  targetHead: string;
  activationTime: Date;
  deadlineTime: Date;
  manifest: CollectorManifest;
}): ReviewDerivedReport[] {
  const reports: ReviewDerivedReport[] = [];
  const seenVersion = new Set<string>();
  const authorToLeg = new Map<string, string>();
  for (const leg of input.manifest.legs) {
    for (const author of leg.expectedAuthors) authorToLeg.set(author, leg.id);
  }

  // Prefer final snapshot versions first, then historical ledger versions.
  const ordered: CollectorEvidenceRecord[] = [];
  for (const id of input.finalSnapshot.evidenceIds) {
    const record = input.ledger.getEvidence(id);
    if (record) ordered.push(record);
  }
  for (const record of input.ledger.allEvidence()) {
    if (!ordered.some((item) => item.evidenceId === record.evidenceId)) {
      ordered.push(record);
    }
  }

  for (const record of ordered) {
    if (record.kind !== "review") continue;
    if (record.authorLogin === undefined) continue;
    const legId = authorToLeg.get(record.authorLogin);
    if (legId === undefined) continue;
    if (seenVersion.has(record.versionId)) continue;
    seenVersion.add(record.versionId);
    // Substantive: any observed review version is retained, including blank non-finding.
    reports.push(
      buildReviewReport({
        legId,
        review: record,
        ledger: input.ledger,
        snapshot: input.finalSnapshot,
        targetHead: input.targetHead,
        activationTime: input.activationTime,
        deadlineTime: input.deadlineTime,
      }),
    );
  }
  return reports;
}

export function buildCollectorReceipt(
  ledger: CollectorLedger,
  candidateRaw: unknown,
): CollectorReceipt {
  ledger.assertNotFatal();
  if (ledger.outputAccepted) fail("Collector output is singleton");
  if (ledger.unresolvedTransportFailure) {
    fail("Collector cannot output while a transport failure is unrecovered");
  }
  if (
    ledger.finalObservationRequired && !ledger.finalObservationCompleted
  ) {
    fail("Collector output requires the necessary final complete observation");
  }
  if (ledger.latestCompleteSnapshotId === undefined) {
    fail("Collector output requires a complete final snapshot");
  }
  if (ledger.activationTime === undefined || ledger.deadlineTime === undefined) {
    fail("Collector output requires activation timeline");
  }

  const candidate = parseCollectorOutputCandidate(candidateRaw);
  const config = ledger.config;
  const finalSnapshot = ledger.getSnapshot(ledger.latestCompleteSnapshotId);
  if (finalSnapshot === undefined || !finalSnapshot.complete) {
    fail("Collector final snapshot is missing or incomplete");
  }
  if (finalSnapshot.prState !== "OPEN") {
    fail("Collector final snapshot PR state is not OPEN");
  }

  const configuredIds = config.manifest.legs.map((leg) => leg.id);
  const candidateIds = candidate.legs.map((leg) => leg.legId);
  if (candidateIds.length !== configuredIds.length) {
    fail("Collector output must cover exactly the configured leg set");
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    fail("Collector output contains duplicate legId values");
  }
  for (const id of configuredIds) {
    if (!candidateIds.includes(id)) {
      fail(`Collector output missing configured leg \"${id}\"`);
    }
  }
  for (const id of candidateIds) {
    if (!configuredIds.includes(id)) {
      fail(`Collector output contains unconfigured leg \"${id}\"`);
    }
  }

  const targetHead = finalSnapshot.headOid;
  const activationTime = ledger.activationTime;
  const deadlineTime = ledger.deadlineTime;
  const legsOut: CollectorReceipt["legs"] = [];
  const terminalReports: TerminalFactReport[] = [];

  for (const legCandidate of candidate.legs) {
    const leg = ledger.legById(legCandidate.legId);
    if (leg === undefined) fail(`Unknown leg ${legCandidate.legId}`);
    const expected = new Set(leg.expectedAuthors);

    for (const ref of legCandidate.evidenceRefs) {
      const record = ledger.getEvidence(ref);
      const snapshotRef = ledger.getSnapshot(ref);
      if (record === undefined && snapshotRef === undefined) {
        fail(
          `Collector evidenceRef \"${ref}\" for leg \"${legCandidate.legId}\" is absent from the ledger`,
        );
      }
    }

    if (legCandidate.status === "valid") {
      let matched: CollectorEvidenceRecord | undefined;
      for (const ref of legCandidate.evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record?.kind !== "review") continue;
        // Must be present in final snapshot
        if (!finalSnapshot.evidenceIds.includes(record.evidenceId)) continue;
        const qualification = reviewQualifiesForValid({
          review: record,
          expectedAuthors: expected,
          targetHead,
          activationTime,
          deadlineTime,
        });
        if (qualification.ok) {
          matched = record;
          break;
        }
      }
      if (matched === undefined) {
        fail(
          `Collector valid leg \"${legCandidate.legId}\" lacks a qualifying latest-snapshot review for target HEAD`,
        );
      }
    } else if (legCandidate.status === "unavailable") {
      let eligible = false;
      for (const ref of legCandidate.evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record === undefined) continue;
        if (
          record.authorLogin === undefined ||
          !expected.has(record.authorLogin)
        ) {
          continue;
        }
        const windowRelation = computeWindowRelation(
          record.authoritativeTime,
          activationTime,
          deadlineTime,
        );
        if (windowRelation !== "before" && windowRelation !== "within") continue;
        // Scope: global can cover any target; target-scoped must bind this snapshot head.
        if (legCandidate.unavailableScope === "global") {
          eligible = true;
          break;
        }
        // target scope: evidence should be associated with current snapshot / head context.
        // Presence in final snapshot is required for target-scoped unavailable.
        if (finalSnapshot.evidenceIds.includes(record.evidenceId)) {
          eligible = true;
          break;
        }
      }
      if (!eligible) {
        fail(
          `Collector unavailable leg \"${legCandidate.legId}\" lacks eligible before/within evidence with declared scope`,
        );
      }
      const windowRelation = (() => {
        for (const ref of legCandidate.evidenceRefs) {
          const record = ledger.getEvidence(ref);
          if (!record) continue;
          return computeWindowRelation(
            record.authoritativeTime,
            activationTime,
            deadlineTime,
          );
        }
        return "uncertain" as const;
      })();
      terminalReports.push({
        kind: "terminal-fact",
        legId: legCandidate.legId,
        terminalStatus: "unavailable",
        report: legCandidate.rationale,
        windowRelation,
        evidenceRefs: [...legCandidate.evidenceRefs],
        ...(legCandidate.unavailableScope === "global"
          ? { scope: "global" as const }
          : { targetSnapshotHead: targetHead }),
      });
    } else {
      // missing
      if (!legCandidate.evidenceRefs.includes(finalSnapshot.snapshotId) &&
        !legCandidate.evidenceRefs.some((ref) =>
          finalSnapshot.evidenceIds.includes(ref) || ref === finalSnapshot.snapshotId
        )) {
        // Require citation of final snapshot via snapshot id or any final evidence id
        const citesFinal = legCandidate.evidenceRefs.some((ref) =>
          ref === finalSnapshot.snapshotId ||
          finalSnapshot.evidenceIds.includes(ref)
        );
        if (!citesFinal) {
          fail(
            `Collector missing leg \"${legCandidate.legId}\" must cite the final complete snapshot`,
          );
        }
      }
      terminalReports.push({
        kind: "terminal-fact",
        legId: legCandidate.legId,
        terminalStatus: "missing",
        report: legCandidate.rationale,
        windowRelation: "within",
        evidenceRefs: [...legCandidate.evidenceRefs],
        targetSnapshotHead: targetHead,
      });
    }

    legsOut.push({
      legId: legCandidate.legId,
      status: legCandidate.status,
      rationale: legCandidate.rationale,
      evidenceRefs: [...legCandidate.evidenceRefs],
    });
  }

  const reviewReports = collectSubstantiveReviewReports({
    ledger,
    finalSnapshot,
    targetHead,
    activationTime,
    deadlineTime,
    manifest: config.manifest,
  });

  const reports: CollectorReport[] = [...reviewReports, ...terminalReports];
  if (reports.length === 0) {
    fail("Collector receipt reports must be non-empty");
  }
  for (const report of reports) {
    if (report.report.trim().length === 0) {
      fail("Collector receipt forbids blank reports");
    }
    if (report.evidenceRefs.length === 0) {
      fail("Collector receipt reports require evidenceRefs");
    }
  }

  // Materialize authoritative subset only: referenced records, configured-author
  // substantive history, request/transport material, and final-snapshot identity
  // records needed to verify conclusions. Unrelated observed records are not
  // copied merely because they were seen.
  const embedEvidenceIds = new Set<string>();
  const embedSnapshotIds = new Set<string>([finalSnapshot.snapshotId]);

  const addEvidence = (id: string) => {
    if (ledger.getEvidence(id)) embedEvidenceIds.add(id);
    if (ledger.getSnapshot(id)) embedSnapshotIds.add(id);
  };

  for (const leg of legsOut) {
    for (const ref of leg.evidenceRefs) addEvidence(ref);
  }
  for (const report of reports) {
    for (const ref of report.evidenceRefs) addEvidence(ref);
  }

  for (const id of finalSnapshot.evidenceIds) {
    const record = ledger.getEvidence(id);
    if (record === undefined) continue;
    if (record.kind === "pull_request" || record.kind === "authenticated_user") {
      embedEvidenceIds.add(record.evidenceId);
    }
  }

  for (const record of ledger.allEvidence()) {
    if (
      record.authorLogin !== undefined &&
      ledger.configuredAuthorLogins().has(record.authorLogin)
    ) {
      if (
        record.kind === "review" ||
        record.kind === "review_comment" ||
        record.kind === "issue_comment"
      ) {
        embedEvidenceIds.add(record.evidenceId);
      }
    }
    if (record.kind === "request_attempt" || record.kind === "transport") {
      embedEvidenceIds.add(record.evidenceId);
    }
    if (
      record.kind === "issue_comment" &&
      record.authorLogin === ledger.requesterLogin &&
      typeof record.body === "string" &&
      record.body.includes("ak-collector:v1")
    ) {
      embedEvidenceIds.add(record.evidenceId);
    }
  }

  for (const attempt of ledger.requestAttempts()) {
    embedSnapshotIds.add(attempt.snapshotId);
    if (attempt.commentEvidenceId) addEvidence(attempt.commentEvidenceId);
  }

  const evidenceRecords = ledger
    .allEvidence()
    .filter((record) => embedEvidenceIds.has(record.evidenceId));
  const snapshots = ledger
    .allSnapshots()
    .filter((snapshot) => embedSnapshotIds.has(snapshot.snapshotId));

  // Ensure every ref resolves exactly once
  const evidenceIndex = new Map(evidenceRecords.map((r) => [r.evidenceId, r]));
  const snapshotIndex = new Map(snapshots.map((s) => [s.snapshotId, s]));
  if (!snapshotIndex.has(finalSnapshot.snapshotId)) {
    fail("Collector receipt missing final snapshot embedding");
  }
  const resolveRef = (ref: string, label: string) => {
    if (evidenceIndex.has(ref) || snapshotIndex.has(ref)) return;
    fail(`Collector receipt ref \"${ref}\" from ${label} does not resolve inside the receipt`);
  };
  for (const leg of legsOut) {
    for (const ref of leg.evidenceRefs) resolveRef(ref, `leg ${leg.legId}`);
  }
  for (const report of reports) {
    for (const ref of report.evidenceRefs) resolveRef(ref, `report ${report.legId}`);
  }

  const receipt: CollectorReceipt = {
    host: COLLECTOR_HOST,
    repository: config.repository.canonical,
    prNumber: config.prNumber,
    manifestVersion: 1,
    manifestDigest: config.manifest.digest,
    activationTime: activationTime.toISOString(),
    deadlineTime: deadlineTime.toISOString(),
    finalObservationTime: finalSnapshot.observedAt,
    finalSnapshotId: finalSnapshot.snapshotId,
    targetHead,
    reports,
    legs: legsOut,
    requestAttempts: [...ledger.requestAttempts()],
    snapshots,
    evidenceRecords,
  };

  const bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  if (bytes > COLLECTOR_RECEIPT_MAX_BYTES) {
    fail(
      `Collector receipt exceeded ${COLLECTOR_RECEIPT_MAX_BYTES} UTF-8 bytes (${bytes})`,
    );
  }

  // Silence unused import helper in some paths
  void isValidReviewState;
  void (null as unknown as CollectorRepository);

  return receipt;
}
