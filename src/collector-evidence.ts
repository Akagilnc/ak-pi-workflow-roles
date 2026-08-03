import { createHash } from "node:crypto";

import type {
  GitHubIssueComment,
  GitHubPageDiagnostics,
  GitHubPullRequest,
  GitHubReview,
  GitHubReviewComment,
  GitHubUser,
} from "./collector-github.ts";

export const COLLECTOR_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const COLLECTOR_RECEIPT_MAX_BYTES = 32 * 1024 * 1024;

export function assertCollectorByteLimit(
  label: string,
  bytes: number,
  maxBytes: number,
): void {
  if (bytes > maxBytes) {
    throw new Error(`Collector ${label} exceeded ${maxBytes} UTF-8 bytes (${bytes})`);
  }
}
export const COLLECTOR_ELIGIBILITY_MS = 15 * 60 * 1000;

export type WindowRelation = "before" | "within" | "after" | "uncertain";
export type HeadRelation = "current" | "prior";

export const VALID_REVIEW_STATES = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
] as const;
export type ValidReviewState = (typeof VALID_REVIEW_STATES)[number];

export type CollectorEvidenceKind =
  | "pull_request"
  | "review"
  | "issue_comment"
  | "review_comment"
  | "authenticated_user"
  | "request_attempt"
  | "wait"
  | "transport";

export type CollectorEvidenceRecord = {
  evidenceId: string;
  kind: CollectorEvidenceKind;
  stableGitHubId?: string;
  versionId: string;
  contentDigest: string;
  authorLogin?: string;
  state?: string;
  body?: string;
  commitOid?: string | null;
  htmlUrl?: string;
  path?: string;
  line?: number | null;
  /** Outdated inline location when current line is null. */
  originalLine?: number | null;
  side?: string | null;
  position?: number | null;
  pullRequestReviewId?: number | null;
  /** GitHub-supplied submission clock for reviews (metadata only). */
  submittedAt?: string | null;
  authoritativeTime?: string | null;
  firstObservedAt: string;
  windowRelation?: WindowRelation;
  raw: unknown;
  pagination?: {
    surface: string;
    complete: boolean;
    pages: GitHubPageDiagnostics[];
  };
};

export type CollectorSnapshot = {
  snapshotId: string;
  observedAt: string;
  /** Wall clock when observe finished successfully. */
  completedAt: string;
  /** Monotonic ms when observe finished successfully. */
  completedMono: number;
  host: "github.com";
  repository: string;
  prNumber: number;
  prState: string;
  headOid: string;
  complete: boolean;
  evidenceIds: string[];
  pageDiagnostics: GitHubPageDiagnostics[];
  normalizedByteLength: number;
};

export type CollectorClock = {
  wallNow(): Date;
  monoNow(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export function createSystemCollectorClock(): CollectorClock {
  const start = process.hrtime.bigint();
  return {
    wallNow: () => new Date(),
    monoNow: () => Number(process.hrtime.bigint() - start) / 1e6,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        const timer = setTimeout(resolve, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  };
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeWindowRelation(
  authoritativeTime: string | null | undefined,
  activationTime: Date,
  deadlineTime: Date,
): WindowRelation {
  if (authoritativeTime === undefined || authoritativeTime === null || authoritativeTime.length === 0) {
    return "uncertain";
  }
  const ms = Date.parse(authoritativeTime);
  if (!Number.isFinite(ms)) return "uncertain";
  const activationMs = activationTime.getTime();
  const deadlineMs = deadlineTime.getTime();
  if (ms < activationMs) return "before";
  if (ms <= deadlineMs) return "within";
  return "after";
}

export function isValidReviewState(state: string): state is ValidReviewState {
  return (VALID_REVIEW_STATES as readonly string[]).includes(state);
}

export function reviewQualifiesForValid(input: {
  review: Pick<CollectorEvidenceRecord, "authorLogin" | "state" | "commitOid" | "authoritativeTime">;
  expectedAuthors: ReadonlySet<string>;
  targetHead: string;
  activationTime: Date;
  deadlineTime: Date;
}): { ok: true; windowRelation: WindowRelation } | { ok: false; reason: string } {
  const author = input.review.authorLogin?.toLowerCase();
  if (author === undefined || !input.expectedAuthors.has(author)) {
    return { ok: false, reason: "author" };
  }
  if (input.review.state === undefined || !isValidReviewState(input.review.state)) {
    return { ok: false, reason: "state" };
  }
  if (
    input.review.commitOid === undefined ||
    input.review.commitOid === null ||
    input.review.commitOid.length === 0
  ) {
    return { ok: false, reason: "commit" };
  }
  if (input.review.commitOid !== input.targetHead) {
    return { ok: false, reason: "head" };
  }
  const windowRelation = computeWindowRelation(
    input.review.authoritativeTime,
    input.activationTime,
    input.deadlineTime,
  );
  if (windowRelation !== "before" && windowRelation !== "within") {
    return { ok: false, reason: "window" };
  }
  return { ok: true, windowRelation };
}

function stableId(kind: string, githubId: string | number): string {
  return `${kind}:${githubId}`;
}

function versionDigest(parts: Record<string, unknown>): string {
  return sha256Text(JSON.stringify(parts));
}

export function evidenceIdFor(kind: string, versionId: string): string {
  return sha256Text(`${kind}:${versionId}`).slice(0, 16);
}

export function normalizeAuthenticatedUserEvidence(
  user: GitHubUser,
  observedAt: string,
): CollectorEvidenceRecord {
  const login = user.login.toLowerCase();
  const rawId = (user.raw as { id?: unknown } | undefined)?.id;
  const stableNumericOrStringId =
    typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined;
  // Retain only correlation identity — never the full /user profile.
  const retainedRaw: { login: string; id?: number | string } = { login };
  if (stableNumericOrStringId !== undefined) {
    retainedRaw.id = stableNumericOrStringId;
  }
  const contentDigest = versionDigest({
    login,
    ...(stableNumericOrStringId !== undefined ? { id: stableNumericOrStringId } : {}),
  });
  const versionId = `user:${login}:${contentDigest.slice(0, 12)}`;
  return {
    evidenceId: evidenceIdFor("authenticated_user", versionId),
    kind: "authenticated_user",
    stableGitHubId: stableId("user", login),
    versionId,
    contentDigest,
    authorLogin: login,
    firstObservedAt: observedAt,
    raw: retainedRaw,
  };
}

export function normalizePullRequestEvidence(
  pr: GitHubPullRequest,
  observedAt: string,
): CollectorEvidenceRecord {
  const contentDigest = versionDigest({
    number: pr.number,
    state: pr.state,
    headOid: pr.headOid,
    updatedAt: pr.updatedAt ?? null,
    htmlUrl: pr.url,
  });
  const versionId = `pr:${pr.number}:${contentDigest.slice(0, 12)}`;
  return {
    evidenceId: evidenceIdFor("pull_request", versionId),
    kind: "pull_request",
    stableGitHubId: stableId("pr", pr.number),
    versionId,
    contentDigest,
    state: pr.state,
    commitOid: pr.headOid,
    htmlUrl: pr.url,
    authoritativeTime: pr.updatedAt ?? null,
    firstObservedAt: observedAt,
    raw: pr.raw,
  };
}

export function normalizeReviewEvidence(
  review: GitHubReview,
  observedAt: string,
): CollectorEvidenceRecord {
  const authorLogin =
    review.userLogin === null || review.userLogin === undefined
      ? undefined
      : review.userLogin.toLowerCase();
  const contentDigest = versionDigest({
    id: review.id,
    state: review.state,
    body: review.body,
    commitId: review.commitId,
    submittedAt: review.submittedAt,
    htmlUrl: review.htmlUrl,
    userLogin: authorLogin ?? null,
  });
  const versionId = `review:${review.id}:${contentDigest.slice(0, 12)}`;
  return {
    evidenceId: evidenceIdFor("review", versionId),
    kind: "review",
    stableGitHubId: stableId("review", review.id),
    versionId,
    contentDigest,
    ...(authorLogin === undefined ? {} : { authorLogin }),
    state: review.state,
    body: review.body,
    commitOid: review.commitId,
    htmlUrl: review.htmlUrl,
    // Submission metadata only; ledger history assigns authoritativeTime.
    submittedAt: review.submittedAt,
    authoritativeTime: review.submittedAt,
    firstObservedAt: observedAt,
    raw: review.raw,
  };
}

export function normalizeIssueCommentEvidence(
  comment: GitHubIssueComment,
  observedAt: string,
): CollectorEvidenceRecord {
  const authorLogin =
    comment.userLogin === null || comment.userLogin === undefined
      ? undefined
      : comment.userLogin.toLowerCase();
  const contentDigest = versionDigest({
    id: comment.id,
    body: comment.body,
    updatedAt: comment.updatedAt,
    userLogin: authorLogin ?? null,
    htmlUrl: comment.htmlUrl,
  });
  const versionId = `issue_comment:${comment.id}:${contentDigest.slice(0, 12)}`;
  return {
    evidenceId: evidenceIdFor("issue_comment", versionId),
    kind: "issue_comment",
    stableGitHubId: stableId("issue_comment", comment.id),
    versionId,
    contentDigest,
    ...(authorLogin === undefined ? {} : { authorLogin }),
    body: comment.body,
    htmlUrl: comment.htmlUrl,
    authoritativeTime: comment.updatedAt ?? null,
    firstObservedAt: observedAt,
    raw: comment.raw,
  };
}

export function normalizeReviewCommentEvidence(
  comment: GitHubReviewComment,
  observedAt: string,
): CollectorEvidenceRecord {
  const authorLogin =
    comment.userLogin === null || comment.userLogin === undefined
      ? undefined
      : comment.userLogin.toLowerCase();
  const contentDigest = versionDigest({
    id: comment.id,
    body: comment.body,
    path: comment.path,
    line: comment.line,
    originalLine: comment.originalLine,
    side: comment.side,
    position: comment.position,
    updatedAt: comment.updatedAt,
    commitId: comment.commitId,
    pullRequestReviewId: comment.pullRequestReviewId,
    userLogin: authorLogin ?? null,
    htmlUrl: comment.htmlUrl,
  });
  const versionId = `review_comment:${comment.id}:${contentDigest.slice(0, 12)}`;
  return {
    evidenceId: evidenceIdFor("review_comment", versionId),
    kind: "review_comment",
    stableGitHubId: stableId("review_comment", comment.id),
    versionId,
    contentDigest,
    ...(authorLogin === undefined ? {} : { authorLogin }),
    body: comment.body,
    commitOid: comment.commitId,
    htmlUrl: comment.htmlUrl,
    path: comment.path,
    line: comment.line,
    originalLine: comment.originalLine,
    side: comment.side,
    position: comment.position,
    pullRequestReviewId: comment.pullRequestReviewId,
    authoritativeTime: comment.updatedAt ?? null,
    firstObservedAt: observedAt,
    raw: comment.raw,
  };
}

/**
 * Ledger history step: first distinct review version may keep submitted_at
 * only when surface-completion mono is at or before deadlineMono; after-deadline
 * first sightings and non-finite mono fail closed to null (no submitted_at
 * backdate). Wall firstObservedAt is receipt/metadata only. Every later distinct
 * review version without a GitHub version timestamp is uncertain. Known
 * versionIds reuse the stored authoritative clock including null. Comments keep
 * their own updated_at per version (null if missing).
 */
export function applyEvidenceVersionHistory(
  pending: CollectorEvidenceRecord[],
  priorEvidence: readonly CollectorEvidenceRecord[],
  cutoff: {
    deadlineMono: number;
    firstObservedMono: number;
  },
): void {
  const versionsByStable = new Map<string, Set<string>>();
  const add = (stableIdValue: string, versionId: string) => {
    let set = versionsByStable.get(stableIdValue);
    if (set === undefined) {
      set = new Set<string>();
      versionsByStable.set(stableIdValue, set);
    }
    set.add(versionId);
  };
  for (const record of priorEvidence) {
    if (record.stableGitHubId !== undefined) {
      add(record.stableGitHubId, record.versionId);
    }
  }
  const priorByVersionId = new Map<string, CollectorEvidenceRecord>();
  for (const record of priorEvidence) {
    priorByVersionId.set(record.versionId, record);
  }

  for (const record of pending) {
    if (record.stableGitHubId === undefined) continue;
    const priorVersions = versionsByStable.get(record.stableGitHubId) ?? new Set<string>();
    const isNewVersion = !priorVersions.has(record.versionId);
    const hadEarlierDistinctVersion = [...priorVersions].some(
      (versionId) => versionId !== record.versionId,
    );

    if (record.kind === "review") {
      if (!isNewVersion) {
        // Known versionId must keep the previously stored authoritative clock.
        const prior = priorByVersionId.get(record.versionId);
        if (prior !== undefined) {
          record.authoritativeTime = prior.authoritativeTime ?? null;
        }
      } else if (hadEarlierDistinctVersion) {
        // Reviews have no GitHub-supplied per-edit timestamp.
        record.authoritativeTime = null;
      } else {
        // First submission version may use submitted_at only when surface
        // completion mono is at/before deadlineMono; after-cutoff first
        // sighting must not backdate via submitted_at. Wall firstObservedAt
        // is metadata only and must not gate trust.
        const { deadlineMono, firstObservedMono } = cutoff;
        if (
          !Number.isFinite(deadlineMono) ||
          !Number.isFinite(firstObservedMono) ||
          firstObservedMono > deadlineMono
        ) {
          record.authoritativeTime = null;
        } else {
          record.authoritativeTime = record.submittedAt ?? null;
        }
      }
    } else if (
      record.kind === "issue_comment" ||
      record.kind === "review_comment"
    ) {
      if (
        record.authoritativeTime === undefined ||
        record.authoritativeTime === ""
      ) {
        record.authoritativeTime = null;
      }
    }

    if (isNewVersion) {
      add(record.stableGitHubId, record.versionId);
    }
  }
}

export function measureNormalizedBytes(records: readonly CollectorEvidenceRecord[]): number {
  return Buffer.byteLength(JSON.stringify(records), "utf8");
}

/**
 * Observation-scoped incremental retain budget over the same normalized record
 * shape measured by {@link measureNormalizedBytes}. Does not apply window/history
 * mutations; the final observe gate remains the exact authority.
 */
export function createSnapshotByteBudget(
  maxBytes: number = COLLECTOR_SNAPSHOT_MAX_BYTES,
): {
  retain(records: readonly CollectorEvidenceRecord[]): void;
} {
  const retained: CollectorEvidenceRecord[] = [];
  return {
    retain(records: readonly CollectorEvidenceRecord[]): void {
      if (records.length === 0) return;
      const candidate =
        retained.length === 0 ? records.slice() : retained.concat(records);
      const bytes = measureNormalizedBytes(candidate);
      if (bytes > maxBytes) {
        throw Object.assign(
          new Error(
            `Collector snapshot exceeded ${maxBytes} UTF-8 bytes (${bytes})`,
          ),
          {
            githubSizeFailure: true,
            normalizedByteLength: bytes,
          },
        );
      }
      retained.push(...records);
    },
  };
}

export function assignWindowRelations(
  records: CollectorEvidenceRecord[],
  activationTime: Date | undefined,
  deadlineTime: Date | undefined,
): void {
  if (activationTime === undefined || deadlineTime === undefined) return;
  for (const record of records) {
    if (
      record.kind === "review" ||
      record.kind === "issue_comment" ||
      record.kind === "review_comment" ||
      record.kind === "pull_request"
    ) {
      record.windowRelation = computeWindowRelation(
        record.authoritativeTime,
        activationTime,
        deadlineTime,
      );
    }
  }
}
