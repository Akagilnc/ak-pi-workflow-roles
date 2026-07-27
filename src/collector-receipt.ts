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
  type CollectorClock,
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

function reviewInlineComments(
  ledger: CollectorLedger,
  review: CollectorEvidenceRecord,
  snapshot: CollectorSnapshot,
): CollectorEvidenceRecord[] {
  return snapshot.evidenceIds
    .map((id) => ledger.getEvidence(id))
    .filter((record): record is CollectorEvidenceRecord =>
      record !== undefined &&
      record.kind === "review_comment" &&
      record.pullRequestReviewId !== undefined &&
      record.pullRequestReviewId !== null &&
      review.stableGitHubId === `review:${record.pullRequestReviewId}`
    );
}

function reviewInlineText(inline: readonly CollectorEvidenceRecord[]): string {
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
    `submitted_at: ${review.authoritativeTime ?? review.submittedAt ?? "unknown"}`,
    `reviewed head: ${review.commitOid ?? "unknown"}`,
    "body: blank",
    "inline comments: 0",
  ].join("\n");
}

function inlineMembershipKey(inline: readonly CollectorEvidenceRecord[]): string {
  return inline
    .map((record) => record.versionId)
    .slice()
    .sort()
    .join(",");
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
  const inline = reviewInlineComments(input.ledger, input.review, input.snapshot);
  const inlineText = reviewInlineText(inline);
  const body = input.review.body ?? "";
  const report = body.trim().length === 0 && inlineText.length === 0
    ? factualNonFindingReport(input.review)
    : [
      body.trim().length === 0 ? "(empty review body)" : body,
      inlineText.length === 0 ? "" : "Inline comments:",
      inlineText,
    ].filter((part) => part.length > 0).join("\n");

  const reviewedHead = input.review.commitOid ?? "";
  const headRelation: HeadRelation =
    reviewedHead === input.targetHead ? "current" : "prior";
  const windowRelation = computeWindowRelation(
    input.review.authoritativeTime,
    input.activationTime,
    input.deadlineTime,
  );
  const evidenceRefs = [input.review.evidenceId, ...inline.map((item) => item.evidenceId)];
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

/**
 * Emit immutable report variants keyed by
 * (reviewVersionId, coObservedInlineVersionMembershipKey) per snapshot.
 */
function collectSubstantiveReviewReports(input: {
  ledger: CollectorLedger;
  finalSnapshot: CollectorSnapshot;
  targetHead: string;
  activationTime: Date;
  deadlineTime: Date;
  manifest: CollectorManifest;
}): ReviewDerivedReport[] {
  const reports: ReviewDerivedReport[] = [];
  const seenVariant = new Set<string>();
  const authorToLeg = new Map<string, string>();
  for (const leg of input.manifest.legs) {
    for (const author of leg.expectedAuthors) authorToLeg.set(author, leg.id);
  }

  for (const snapshot of input.ledger.allSnapshots()) {
    for (const id of snapshot.evidenceIds) {
      const record = input.ledger.getEvidence(id);
      if (record === undefined || record.kind !== "review") continue;
      if (record.authorLogin === undefined) continue;
      const legId = authorToLeg.get(record.authorLogin);
      if (legId === undefined) continue;
      const inline = reviewInlineComments(input.ledger, record, snapshot);
      const membership = inlineMembershipKey(inline);
      const variantKey = `${record.versionId}|${membership}`;
      if (seenVariant.has(variantKey)) continue;
      seenVariant.add(variantKey);
      reports.push(
        buildReviewReport({
          legId,
          review: record,
          ledger: input.ledger,
          snapshot,
          targetHead: input.targetHead,
          activationTime: input.activationTime,
          deadlineTime: input.deadlineTime,
        }),
      );
    }
  }
  return reports;
}

function qualifiesUnavailableEvidence(input: {
  record: CollectorEvidenceRecord;
  expected: ReadonlySet<string>;
  activationTime: Date;
  deadlineTime: Date;
  scope: "target" | "global";
  finalSnapshot: CollectorSnapshot;
}): { ok: true; windowRelation: WindowRelation } | { ok: false } {
  if (
    input.record.authorLogin === undefined ||
    !input.expected.has(input.record.authorLogin)
  ) {
    return { ok: false };
  }
  const windowRelation = computeWindowRelation(
    input.record.authoritativeTime,
    input.activationTime,
    input.deadlineTime,
  );
  if (windowRelation !== "before" && windowRelation !== "within") {
    return { ok: false };
  }
  if (input.scope === "global") {
    return { ok: true, windowRelation };
  }
  if (input.finalSnapshot.evidenceIds.includes(input.record.evidenceId)) {
    return { ok: true, windowRelation };
  }
  return { ok: false };
}

function collectMissingProofRefs(input: {
  ledger: CollectorLedger;
  legId: string;
  expected: ReadonlySet<string>;
  finalSnapshot: CollectorSnapshot;
}): string[] {
  const refs = new Set<string>([input.finalSnapshot.snapshotId]);
  for (const record of input.ledger.allEvidence()) {
    if (record.authorLogin !== undefined && input.expected.has(record.authorLogin)) {
      if (
        record.kind === "review" ||
        record.kind === "review_comment" ||
        record.kind === "issue_comment"
      ) {
        // pending/negative/dismissed/after/uncertain same-leg material
        refs.add(record.evidenceId);
      }
    }
    if (
      record.kind === "issue_comment" &&
      record.authorLogin === input.ledger.requesterLogin &&
      typeof record.body === "string" &&
      record.body.includes("ak-collector:v1")
    ) {
      refs.add(record.evidenceId);
    }
  }
  for (const attempt of input.ledger.requestAttempts()) {
    if (attempt.legId !== input.legId) continue;
    if (attempt.commentEvidenceId) refs.add(attempt.commentEvidenceId);
    if (attempt.recoverySnapshotId) refs.add(attempt.recoverySnapshotId);
    refs.add(attempt.snapshotId);
  }
  for (const failure of input.ledger.transportFailures()) {
    if (failure.legId !== undefined && failure.legId !== input.legId) continue;
    // diagnostics live on attempts; still ensure related snapshots stay linked
    void failure;
  }
  for (const id of input.finalSnapshot.evidenceIds) {
    const record = input.ledger.getEvidence(id);
    if (record?.kind === "pull_request" || record?.kind === "authenticated_user") {
      refs.add(record.evidenceId);
    }
  }
  return [...refs];
}

export function buildCollectorReceipt(
  ledger: CollectorLedger,
  candidateRaw: unknown,
  clock?: CollectorClock,
): CollectorReceipt {
  ledger.assertNotFatal();
  if (ledger.outputAccepted) fail("Collector output is singleton");
  if (ledger.unresolvedTransportFailure) {
    fail("Collector cannot output while a transport failure is unrecovered");
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

  if (clock !== undefined) {
    try {
      ledger.assertOutputObservationLaw(candidate, clock);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  } else {
    // Backward-compatible path for pure unit tests without a clock: still enforce dirty-clear.
    if (ledger.observedGeneration !== ledger.mutationGeneration) {
      fail(
        "Collector output requires a complete observe after the latest request/wait mutation",
      );
    }
    if (
      ledger.finalObservationRequired && !ledger.finalObservationCompleted
    ) {
      fail("Collector output requires the necessary final complete observation");
    }
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
    let evidenceRefs = [...legCandidate.evidenceRefs];

    for (const ref of evidenceRefs) {
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
      for (const ref of evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record?.kind !== "review") continue;
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
      const scope = legCandidate.unavailableScope;
      if (scope !== "target" && scope !== "global") {
        fail(
          `Collector unavailable leg \"${legCandidate.legId}\" requires unavailableScope target|global`,
        );
      }

      // Reject wrong-author / non-leg decoy refs fail-closed.
      for (const ref of evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record === undefined) continue;
        if (
          record.authorLogin !== undefined &&
          !expected.has(record.authorLogin) &&
          record.authorLogin !== ledger.requesterLogin
        ) {
          fail(
            `Collector unavailable leg \"${legCandidate.legId}\" cites wrong-author evidence \"${ref}\"`,
          );
        }
      }

      const qualifying: Array<{ record: CollectorEvidenceRecord; windowRelation: WindowRelation }> =
        [];
      for (const ref of evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record === undefined) continue;
        const result = qualifiesUnavailableEvidence({
          record,
          expected,
          activationTime,
          deadlineTime,
          scope,
          finalSnapshot,
        });
        if (result.ok) {
          qualifying.push({ record, windowRelation: result.windowRelation });
        }
      }
      if (qualifying.length === 0) {
        fail(
          `Collector unavailable leg \"${legCandidate.legId}\" lacks eligible before/within evidence with declared scope`,
        );
      }
      const windowRelation = qualifying[0]!.windowRelation;
      const proofRefs = qualifying.map((item) => item.record.evidenceId);
      // Bind terminal report refs to qualifying proof, preserving any additional non-decoy refs.
      const boundRefs = [
        ...proofRefs,
        ...evidenceRefs.filter((ref) => !proofRefs.includes(ref)),
      ];
      evidenceRefs = boundRefs;
      terminalReports.push({
        kind: "terminal-fact",
        legId: legCandidate.legId,
        terminalStatus: "unavailable",
        report: legCandidate.rationale,
        windowRelation,
        evidenceRefs: [...boundRefs],
        ...(scope === "global"
          ? { scope: "global" as const }
          : { targetSnapshotHead: targetHead }),
      });
    } else {
      // missing — auto-link required proof material into leg and report refs
      const auto = collectMissingProofRefs({
        ledger,
        legId: legCandidate.legId,
        expected,
        finalSnapshot,
      });
      const merged = new Set<string>([...evidenceRefs, ...auto]);
      // Must cite final complete snapshot
      if (!merged.has(finalSnapshot.snapshotId)) {
        merged.add(finalSnapshot.snapshotId);
      }
      const citesFinal = [...merged].some((ref) =>
        ref === finalSnapshot.snapshotId ||
        finalSnapshot.evidenceIds.includes(ref)
      );
      if (!citesFinal) {
        fail(
          `Collector missing leg \"${legCandidate.legId}\" must cite the final complete snapshot`,
        );
      }
      evidenceRefs = [...merged];
      terminalReports.push({
        kind: "terminal-fact",
        legId: legCandidate.legId,
        terminalStatus: "missing",
        report: legCandidate.rationale,
        windowRelation: "within",
        evidenceRefs: [...evidenceRefs],
        targetSnapshotHead: targetHead,
      });
    }

    legsOut.push({
      legId: legCandidate.legId,
      status: legCandidate.status,
      rationale: legCandidate.rationale,
      evidenceRefs: [...evidenceRefs],
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
    if (attempt.recoverySnapshotId) embedSnapshotIds.add(attempt.recoverySnapshotId);
  }

  const evidenceRecords = ledger
    .allEvidence()
    .filter((record) => embedEvidenceIds.has(record.evidenceId));
  const snapshots = ledger
    .allSnapshots()
    .filter((snapshot) => embedSnapshotIds.has(snapshot.snapshotId));

  // Unique ids within each namespace
  const evidenceIds = evidenceRecords.map((record) => record.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    fail("Collector receipt evidenceId collision");
  }
  const snapshotIds = snapshots.map((snapshot) => snapshot.snapshotId);
  if (new Set(snapshotIds).size !== snapshotIds.length) {
    fail("Collector receipt snapshotId collision");
  }

  const evidenceIndex = new Map(evidenceRecords.map((r) => [r.evidenceId, r]));
  const snapshotIndex = new Map(snapshots.map((s) => [s.snapshotId, s]));
  if (!snapshotIndex.has(finalSnapshot.snapshotId)) {
    fail("Collector receipt missing final snapshot embedding");
  }

  // Exactly-one resolution across the two namespaces
  for (const id of evidenceIds) {
    if (snapshotIndex.has(id)) {
      fail(
        `Collector receipt id \"${id}\" is ambiguous across evidence and snapshot namespaces`,
      );
    }
  }
  for (const id of snapshotIds) {
    if (evidenceIndex.has(id)) {
      fail(
        `Collector receipt id \"${id}\" is ambiguous across evidence and snapshot namespaces`,
      );
    }
  }

  const resolveRef = (ref: string, label: string) => {
    const inEvidence = evidenceIndex.has(ref);
    const inSnapshot = snapshotIndex.has(ref);
    if (inEvidence && inSnapshot) {
      fail(`Collector receipt ref \"${ref}\" from ${label} is ambiguous`);
    }
    if (!inEvidence && !inSnapshot) {
      fail(
        `Collector receipt ref \"${ref}\" from ${label} does not resolve inside the receipt`,
      );
    }
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
    finalObservationTime: finalSnapshot.completedAt ?? finalSnapshot.observedAt,
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
    throw ledger.latchFatal(
      `Collector receipt exceeded ${COLLECTOR_RECEIPT_MAX_BYTES} UTF-8 bytes (${bytes})`,
    );
  }

  void isValidReviewState;
  void (null as unknown as CollectorRepository);

  return receipt;
}
