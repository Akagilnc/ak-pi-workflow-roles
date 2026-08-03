import Value from "typebox/value";

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
import { collectorOutputArgsSchema } from "./collector-tool-schemas.ts";
import { validateAcceptedCollectorReceipt } from "./package-contracts/collector-output.ts";

export { validateAcceptedCollectorReceipt };

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

export function parseCollectorOutputCandidate(
  raw: unknown,
): CollectorOutputCandidate {
  if (!Value.Check(collectorOutputArgsSchema, raw)) {
    fail("Collector output failed schema validation");
  }
  const checked = raw as {
    legs: Array<{
      legId: string;
      status: CollectorLegStatus;
      rationale: string;
      evidenceRefs: string[];
      unavailableScope?: "target" | "global";
    }>;
  };
  return {
    legs: checked.legs.map((leg) => {
      const candidate: CollectorLegCandidate = {
        legId: leg.legId,
        status: leg.status,
        rationale: leg.rationale,
        evidenceRefs: [...leg.evidenceRefs],
      };
      if (leg.status === "unavailable") {
        // Schema acceptance already requires unavailableScope target|global.
        candidate.unavailableScope = leg.unavailableScope as "target" | "global";
      }
      return candidate;
    }),
  };
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
      review.stableGitHubId === `review:${record.pullRequestReviewId}` &&
      // Report attachment only: same-author ownership; raw ledger retains intruders.
      record.authorLogin === review.authorLogin
    );
}

function reviewInlineText(inline: readonly CollectorEvidenceRecord[]): string {
  if (inline.length === 0) return "";
  return inline
    .map((comment) => {
      const line =
        comment.line !== null && comment.line !== undefined
          ? comment.line
          : comment.originalLine !== null && comment.originalLine !== undefined
            ? comment.originalLine
            : undefined;
      const loc = [
        comment.path ?? "?",
        line === undefined ? "?" : String(line),
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

function finalHasQualifyingValidReview(input: {
  ledger: CollectorLedger;
  leg: { expectedAuthors: readonly string[] };
  finalSnapshot: CollectorSnapshot;
  targetHead: string;
  activationTime: Date;
  deadlineTime: Date;
}): boolean {
  const expected = new Set(input.leg.expectedAuthors);
  for (const id of input.finalSnapshot.evidenceIds) {
    const record = input.ledger.getEvidence(id);
    if (record === undefined || record.kind !== "review") continue;
    if (
      reviewQualifiesForValid({
        review: record,
        expectedAuthors: expected,
        targetHead: input.targetHead,
        activationTime: input.activationTime,
        deadlineTime: input.deadlineTime,
      }).ok
    ) {
      return true;
    }
  }
  return false;
}

function qualifiesUnavailableEvidence(input: {
  record: CollectorEvidenceRecord;
  expected: ReadonlySet<string>;
  activationTime: Date;
  deadlineTime: Date;
  scope: "target" | "global";
  targetHead: string;
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
    // Global is kind-agnostic: author + before/within only.
    return { ok: true, windowRelation };
  }
  // Target scope: only review / review_comment whose carried commitOid exactly
  // equals targetHead. issue_comment never proves target (no synthetic binder).
  if (input.record.kind !== "review" && input.record.kind !== "review_comment") {
    return { ok: false };
  }
  if (
    input.record.commitOid === undefined ||
    input.record.commitOid === null ||
    input.record.commitOid !== input.targetHead
  ) {
    return { ok: false };
  }
  return { ok: true, windowRelation };
}

/**
 * Latest chronological same-leg attempt that succeeded or recovered with
 * at least one of commentEvidenceId / recoverySnapshotId present.
 */
function latestRelevantAttempt(
  ledger: CollectorLedger,
  legId: string,
): CollectorRequestAttempt | undefined {
  let latest: CollectorRequestAttempt | undefined;
  for (const attempt of ledger.requestAttempts()) {
    if (attempt.legId !== legId) continue;
    if (attempt.status !== "succeeded" && attempt.status !== "recovered") continue;
    if (
      typeof attempt.commentEvidenceId !== "string" &&
      typeof attempt.recoverySnapshotId !== "string"
    ) {
      continue;
    }
    latest = attempt;
  }
  return latest;
}

/** Auto-link only the latest relevant attempt's present proof ids (+ final snapshot). */
function collectMissingProofRefs(input: {
  ledger: CollectorLedger;
  legId: string;
  finalSnapshot: CollectorSnapshot;
}): string[] {
  const refs = new Set<string>([input.finalSnapshot.snapshotId]);
  const latest = latestRelevantAttempt(input.ledger, input.legId);
  if (latest !== undefined) {
    if (typeof latest.commentEvidenceId === "string") {
      refs.add(latest.commentEvidenceId);
    }
    refs.add(latest.snapshotId);
    if (typeof latest.recoverySnapshotId === "string") {
      refs.add(latest.recoverySnapshotId);
    }
  }
  return [...refs];
}

/** Missing model cites are fail-closed to this allow-list. */
function missingCiteAllowed(input: {
  ref: string;
  ledger: CollectorLedger;
  legId: string;
  expected: ReadonlySet<string>;
  finalSnapshot: CollectorSnapshot;
}): boolean {
  if (input.ref === input.finalSnapshot.snapshotId) return true;

  const record = input.ledger.getEvidence(input.ref);
  if (record !== undefined) {
    if (
      (record.kind === "pull_request" || record.kind === "authenticated_user") &&
      input.finalSnapshot.evidenceIds.includes(record.evidenceId)
    ) {
      return true;
    }
    if (
      record.authorLogin !== undefined &&
      input.expected.has(record.authorLogin) &&
      (record.kind === "review" ||
        record.kind === "review_comment" ||
        record.kind === "issue_comment")
    ) {
      return true;
    }
    // Marker-joined same-leg requester comments only (no independent v1 parser).
    if (
      record.kind === "issue_comment" &&
      record.authorLogin === input.ledger.requesterLogin &&
      typeof record.body === "string"
    ) {
      for (const attempt of input.ledger.requestAttempts()) {
        if (attempt.legId !== input.legId) continue;
        if (record.body.includes(attempt.marker)) return true;
      }
    }
  }

  for (const attempt of input.ledger.requestAttempts()) {
    if (attempt.legId !== input.legId) continue;
    if (attempt.snapshotId === input.ref) return true;
    if (attempt.commentEvidenceId === input.ref) return true;
    if (attempt.recoverySnapshotId === input.ref) return true;
  }

  // Transport failures never enter leg/report refs.
  return false;
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
      // Every model cite must independently qualify for this leg on the final snapshot.
      const qualifying: CollectorEvidenceRecord[] = [];
      for (const ref of evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record === undefined || record.kind !== "review") {
          fail(
            `Collector valid leg \"${legCandidate.legId}\" cites non-qualifying evidence \"${ref}\"`,
          );
        }
        if (!finalSnapshot.evidenceIds.includes(record.evidenceId)) {
          fail(
            `Collector valid leg \"${legCandidate.legId}\" cites non-final-snapshot evidence \"${ref}\"`,
          );
        }
        const qualification = reviewQualifiesForValid({
          review: record,
          expectedAuthors: expected,
          targetHead,
          activationTime,
          deadlineTime,
        });
        if (!qualification.ok) {
          fail(
            `Collector valid leg \"${legCandidate.legId}\" cites non-qualifying exact-head evidence \"${ref}\"`,
          );
        }
        qualifying.push(record);
      }
      if (qualifying.length === 0) {
        fail(
          `Collector valid leg \"${legCandidate.legId}\" lacks a qualifying latest-snapshot review for target HEAD`,
        );
      }
      evidenceRefs = qualifying.map((record) => record.evidenceId);
    } else if (legCandidate.status === "unavailable") {
      // Terminal statuses lose to exact-HEAD qualifying valid proof on final snapshot.
      if (
        finalHasQualifyingValidReview({
          ledger,
          leg,
          finalSnapshot,
          targetHead,
          activationTime,
          deadlineTime,
        })
      ) {
        fail(
          `Collector unavailable leg \"${legCandidate.legId}\" rejected: final snapshot has a qualifying exact-head valid review`,
        );
      }
      const scope = legCandidate.unavailableScope;
      if (scope !== "target" && scope !== "global") {
        fail(
          `Collector unavailable leg \"${legCandidate.legId}\" requires unavailableScope target|global`,
        );
      }

      // Every model cite must independently qualify; bind only qualifying proof.
      const qualifying: Array<{ record: CollectorEvidenceRecord; windowRelation: WindowRelation }> =
        [];
      for (const ref of evidenceRefs) {
        const record = ledger.getEvidence(ref);
        if (record === undefined) {
          fail(
            `Collector unavailable leg \"${legCandidate.legId}\" cites non-qualifying evidence \"${ref}\"`,
          );
        }
        const result = qualifiesUnavailableEvidence({
          record,
          expected,
          activationTime,
          deadlineTime,
          scope,
          targetHead,
        });
        if (!result.ok) {
          if (
            record.authorLogin !== undefined &&
            !expected.has(record.authorLogin)
          ) {
            fail(
              `Collector unavailable leg \"${legCandidate.legId}\" cites wrong-author evidence \"${ref}\"`,
            );
          }
          fail(
            `Collector unavailable leg \"${legCandidate.legId}\" cites non-eligible evidence \"${ref}\"`,
          );
        }
        qualifying.push({ record, windowRelation: result.windowRelation });
      }
      if (qualifying.length === 0) {
        fail(
          `Collector unavailable leg \"${legCandidate.legId}\" lacks eligible before/within evidence with declared scope`,
        );
      }
      const windowRelation = qualifying[0]!.windowRelation;
      const proofRefs = qualifying.map((item) => item.record.evidenceId);
      evidenceRefs = [...proofRefs];
      terminalReports.push({
        kind: "terminal-fact",
        legId: legCandidate.legId,
        terminalStatus: "unavailable",
        report: legCandidate.rationale,
        windowRelation,
        evidenceRefs: [...proofRefs],
        ...(scope === "global"
          ? { scope: "global" as const }
          : { targetSnapshotHead: targetHead }),
      });
    } else {
      // Terminal statuses lose to exact-HEAD qualifying valid proof on final snapshot.
      if (
        finalHasQualifyingValidReview({
          ledger,
          leg,
          finalSnapshot,
          targetHead,
          activationTime,
          deadlineTime,
        })
      ) {
        fail(
          `Collector missing leg \"${legCandidate.legId}\" rejected: final snapshot has a qualifying exact-head valid review`,
        );
      }
      // missing — validate model cites, auto-link only latestRelevant attempt proof
      for (const ref of evidenceRefs) {
        if (
          !missingCiteAllowed({
            ref,
            ledger,
            legId: legCandidate.legId,
            expected,
            finalSnapshot,
          })
        ) {
          fail(
            `Collector missing leg \"${legCandidate.legId}\" cites disallowed evidence \"${ref}\"`,
          );
        }
      }
      const auto = collectMissingProofRefs({
        ledger,
        legId: legCandidate.legId,
        finalSnapshot,
      });
      const merged = new Set<string>([...evidenceRefs, ...auto]);
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

  // Full ledger embed — no selective subset. Invocation already bounds size.
  const evidenceRecords = [...ledger.allEvidence()];
  const snapshots = [...ledger.allSnapshots()];

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
  // Transitive closure: every included snapshot evidence id must resolve.
  for (const snapshot of snapshots) {
    for (const id of snapshot.evidenceIds) {
      resolveRef(id, `snapshot ${snapshot.snapshotId} evidenceIds`);
    }
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
  const receiptMaxBytes =
    ledger.config.receiptMaxBytes ?? COLLECTOR_RECEIPT_MAX_BYTES;
  if (bytes > receiptMaxBytes) {
    throw ledger.latchFatal(
      `Collector receipt exceeded ${receiptMaxBytes} UTF-8 bytes (${bytes})`,
    );
  }

  void isValidReviewState;
  void (null as unknown as CollectorRepository);

  return receipt;
}
