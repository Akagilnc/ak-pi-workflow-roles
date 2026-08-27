import Value from "typebox/value";

import type { CollectorManifest, CollectorRepository } from "./collector-config.ts";
import {
  applyEvidenceVersionHistory,
  assignWindowRelations,
  COLLECTOR_ELIGIBILITY_MS,
  measureNormalizedBytes,
  normalizeAuthenticatedUserEvidence,
  normalizeIssueCommentEvidence,
  normalizePullRequestEvidence,
  normalizePullRequestReactionEvidence,
  normalizeReviewCommentEvidence,
  normalizeReviewEvidence,
  sha256Text,
  type CollectorClock,
  type CollectorEvidenceRecord,
  type CollectorSnapshot,
} from "./collector-evidence.ts";
import {
  buildCollectorRequestBody,
  type CollectorGitHubTransport,
  type GitHubPageDiagnostics,
  type GitHubPullRequest,
} from "./collector-github.ts";
import {
  collectorObserveArgsSchema,
  collectorOutputArgsSchema,
  collectorRequestArgsSchema,
  collectorWaitArgsSchema,
} from "./collector-tool-schemas.ts";
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";

export const COLLECTOR_OBSERVE_TOOL = "ak_collector_observe";
export const COLLECTOR_REQUEST_TOOL = "ak_collector_request";
export const COLLECTOR_WAIT_TOOL = "ak_collector_wait";
export { COLLECTOR_OUTPUT_TOOL };

export const COLLECTOR_OPERATIONAL_TOOLS = [
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
] as const;

export type CollectorOperationalTool = (typeof COLLECTOR_OPERATIONAL_TOOLS)[number];

export type CollectorRequestAttempt = {
  attemptId: string;
  requestId: string;
  observedHead: string;
  snapshotId: string;
  marker: string;
  body: string;
  startedAt: string;
  status: "started" | "succeeded" | "rejected" | "ambiguous_loss" | "recovered";
  responseDiagnostics?: string;
  commentEvidenceId?: string;
  /** Snapshot whose observation first established the authenticated marker. */
  recoverySnapshotId?: string;
};

export type CollectorWaitRecord = {
  waitId: string;
  requestedMs: number;
  effectiveMs: number;
  startedAt: string;
  endedAt: string;
  cutoffReached: boolean;
};

export type CollectorTransportFailure = {
  failureId: string;
  kind: "ambiguous_request_loss" | "api" | "pagination" | "size";
  message: string;
  requestId?: string;
  observedHead?: string;
  marker?: string;
  recovered: boolean;
};

export type CollectorConfigState = {
  repository: CollectorRepository;
  prNumber: number;
  manifest: CollectorManifest;
};

export type CollectorLedger = {
  readonly config: CollectorConfigState;
  readonly fatal: boolean;
  readonly fatalReason: string | undefined;
  readonly outputAccepted: boolean;
  readonly activationRecorded: boolean;
  readonly activationTime: Date | undefined;
  readonly deadlineTime: Date | undefined;
  readonly activationMono: number | undefined;
  readonly deadlineMono: number | undefined;
  readonly requesterLogin: string | undefined;
  readonly latestCompleteSnapshotId: string | undefined;
  readonly finalObservationRequired: boolean;
  readonly finalObservationCompleted: boolean;
  readonly unresolvedTransportFailure: boolean;
  readonly mutationGeneration: number;
  readonly observedGeneration: number;

  latchFatal(reason: string, cause?: unknown): Error;
  assertNotFatal(): void;
  recordActivation(clock: CollectorClock): void;
  beginOperational(toolName: string, toolCallId: string): void;
  completeOperational(toolCallId: string): void;
  markOutputAccepted(): void;
  noteCutoffObserved(): void;
  assertOutputObservationLaw(clock: CollectorClock): void;

  observe(
    transport: CollectorGitHubTransport,
    clock: CollectorClock,
    signal?: AbortSignal,
  ): Promise<{
    snapshot: CollectorSnapshot;
    modelView: unknown;
  }>;

  request(
    input: { requestId: string; snapshotId: string },
    transport: CollectorGitHubTransport,
    clock: CollectorClock,
    signal?: AbortSignal,
  ): Promise<unknown>;

  wait(
    input: { durationMs: number },
    clock: CollectorClock,
    signal?: AbortSignal,
  ): Promise<unknown>;

  getSnapshot(snapshotId: string): CollectorSnapshot | undefined;
  getEvidence(evidenceId: string): CollectorEvidenceRecord | undefined;
  allEvidence(): readonly CollectorEvidenceRecord[];
  allSnapshots(): readonly CollectorSnapshot[];
  requestAttempts(): readonly CollectorRequestAttempt[];
  waits(): readonly CollectorWaitRecord[];
  transportFailures(): readonly CollectorTransportFailure[];
  requestById(requestId: string): CollectorConfigState["manifest"]["requests"][number] | undefined;
};

function isOperationalTool(name: string): name is CollectorOperationalTool {
  return (COLLECTOR_OPERATIONAL_TOOLS as readonly string[]).includes(name);
}

/** Shared Check owner for Collector tool argument shapes (schema seam, not batch law). */
export function collectorToolArgumentsValid(
  name: string,
  args: unknown,
): boolean {
  // Residual envelope: reject missing/null args before schema check.
  if (args === undefined || args === null) return false;
  switch (name) {
    case COLLECTOR_OBSERVE_TOOL:
      return Value.Check(collectorObserveArgsSchema, args);
    case COLLECTOR_REQUEST_TOOL:
      return Value.Check(collectorRequestArgsSchema, args);
    case COLLECTOR_WAIT_TOOL:
      return Value.Check(collectorWaitArgsSchema, args);
    case COLLECTOR_OUTPUT_TOOL:
      return Value.Check(collectorOutputArgsSchema, args);
    default:
      return false;
  }
}

export function createCollectorLedger(config: CollectorConfigState): CollectorLedger {
  let fatal = false;
  let fatalReason: string | undefined;
  let outputAccepted = false;
  let activationTime: Date | undefined;
  let deadlineTime: Date | undefined;
  let activationMono: number | undefined;
  let deadlineMono: number | undefined;
  let requesterLogin: string | undefined;
  let latestCompleteSnapshotId: string | undefined;
  let finalObservationRequired = false;
  let finalObservationCompleted = false;
  let activeOperationalCallId: string | undefined;
  let mutationGeneration = 0;
  let observedGeneration = 0;

  const evidenceById = new Map<string, CollectorEvidenceRecord>();
  const evidenceByVersion = new Map<string, string>();
  const snapshots: CollectorSnapshot[] = [];
  const attempts: CollectorRequestAttempt[] = [];
  const attemptKeys = new Set<string>();
  const waits: CollectorWaitRecord[] = [];
  const transportFailures: CollectorTransportFailure[] = [];

  const latchFatal = (reason: string, cause?: unknown): Error => {
    fatal = true;
    fatalReason = reason;
    const error = new Error(reason, cause === undefined ? undefined : { cause });
    Object.assign(error, { collectorFatal: true });
    return error;
  };

  const assertNotFatal = (): void => {
    if (fatal) throw new Error(fatalReason ?? "通进司致命状态");
  };

  const storeEvidence = (record: CollectorEvidenceRecord): CollectorEvidenceRecord => {
    const existingId = evidenceByVersion.get(record.versionId);
    if (existingId !== undefined) {
      return evidenceById.get(existingId) ?? record;
    }
    evidenceByVersion.set(record.versionId, record.evidenceId);
    evidenceById.set(record.evidenceId, record);
    return record;
  };

  const monoNowOrThrow = (clock: CollectorClock): number => clock.monoNow();

  const pastCutoff = (clock: CollectorClock): boolean => {
    if (deadlineMono === undefined) return false;
    return monoNowOrThrow(clock) >= deadlineMono;
  };

  const remainingMs = (clock: CollectorClock): number => {
    if (deadlineMono === undefined) return COLLECTOR_ELIGIBILITY_MS;
    return Math.max(0, deadlineMono - monoNowOrThrow(clock));
  };

  const prIdentity = (pr: GitHubPullRequest): string =>
    `${pr.state}|${pr.headOid}|${pr.updatedAt ?? ""}`;

  const fetchObserveSurfaces = async (
    transport: CollectorGitHubTransport,
    observedAt: string,
    signal?: AbortSignal,
  ) => {
    const owner = config.repository.owner;
    const repo = config.repository.repo;
    const prNumber = config.prNumber;
    const signalOpt = signal === undefined ? {} : { signal };
    const user = await transport.getAuthenticatedUser(signalOpt);
    const prInitial = await transport.getPullRequest({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    const reviews = await transport.listPullRequestReviews({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    const reactions = transport.listPullRequestReactions === undefined
      ? { items: [], pages: [] }
      : await transport.listPullRequestReactions({ owner, repo, prNumber, ...signalOpt });
    const issueComments = await transport.listIssueComments({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    const reviewComments = await transport.listReviewComments({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    const prTerminal = await transport.getPullRequest({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    return { user, prInitial, reviews, reactions, issueComments, reviewComments, prTerminal };
  };

  const ledger: CollectorLedger = {
    get config() {
      return config;
    },
    get fatal() {
      return fatal;
    },
    get fatalReason() {
      return fatalReason;
    },
    get outputAccepted() {
      return outputAccepted;
    },
    get activationRecorded() {
      return activationTime !== undefined;
    },
    get activationTime() {
      return activationTime;
    },
    get deadlineTime() {
      return deadlineTime;
    },
    get activationMono() {
      return activationMono;
    },
    get deadlineMono() {
      return deadlineMono;
    },
    get requesterLogin() {
      return requesterLogin;
    },
    get latestCompleteSnapshotId() {
      return latestCompleteSnapshotId;
    },
    get finalObservationRequired() {
      return finalObservationRequired;
    },
    get finalObservationCompleted() {
      return finalObservationCompleted;
    },
    get unresolvedTransportFailure() {
      return transportFailures.some((failure) => !failure.recovered);
    },
    get mutationGeneration() {
      return mutationGeneration;
    },
    get observedGeneration() {
      return observedGeneration;
    },

    latchFatal,
    assertNotFatal,

    recordActivation(clock) {
      assertNotFatal();
      if (activationTime !== undefined) return;
      activationTime = clock.wallNow();
      activationMono = clock.monoNow();
      deadlineTime = new Date(activationTime.getTime() + COLLECTOR_ELIGIBILITY_MS);
      deadlineMono = activationMono + COLLECTOR_ELIGIBILITY_MS;
    },

    beginOperational(toolName, toolCallId) {
      assertNotFatal();
      if (outputAccepted && toolName !== COLLECTOR_OUTPUT_TOOL) {
        throw latchFatal("回执已受理，本局不再受理操作");
      }
      // Idempotent for the same call across tool_call preflight and execute.
      if (activeOperationalCallId === toolCallId) {
        return;
      }
      if (activeOperationalCallId !== undefined) {
        throw latchFatal("Collector operational call already active");
      }

      if (toolName === COLLECTOR_OUTPUT_TOOL) {
        return;
      }

      if (!isOperationalTool(toolName)) {
        throw latchFatal(`Unknown Collector tool ${toolName}`);
      }
      activeOperationalCallId = toolCallId;
    },

    completeOperational(toolCallId) {
      if (activeOperationalCallId === toolCallId) {
        activeOperationalCallId = undefined;
      }
    },

    markOutputAccepted() {
      assertNotFatal();
      if (outputAccepted) throw latchFatal("Collector output is singleton");
      outputAccepted = true;
    },

    noteCutoffObserved() {
      finalObservationRequired = true;
    },

    assertOutputObservationLaw(clock) {
      assertNotFatal();
      if (activationTime === undefined || deadlineTime === undefined || deadlineMono === undefined) {
        throw new Error("Collector output requires activation timeline");
      }
      if (latestCompleteSnapshotId === undefined) {
        throw new Error("Collector output requires a complete final snapshot");
      }
      if (observedGeneration !== mutationGeneration) {
        throw new Error(
          "Collector output requires a complete observe after the latest request/wait mutation",
        );
      }
      const snapshot = snapshots.find((item) => item.snapshotId === latestCompleteSnapshotId);
      if (snapshot === undefined || !snapshot.complete) {
        throw new Error("Collector final snapshot is missing or incomplete");
      }

      const mono = monoNowOrThrow(clock);
      const atOrAfterCutoff = mono >= deadlineMono;
      if (atOrAfterCutoff) {
        finalObservationRequired = true;
        if (
          snapshot.completedMono === undefined ||
          snapshot.completedMono < deadlineMono
        ) {
          throw new Error(
            "Collector output at/after cutoff requires a complete observation finished at or after the cutoff",
          );
        }
        finalObservationCompleted = true;
      }
    },

    async observe(transport, clock, signal) {
      assertNotFatal();
      if (activationTime === undefined) {
        throw latchFatal("Collector observe requires activation");
      }
      if (signal?.aborted) {
        const abortMessage = signal.reason instanceof Error
          ? signal.reason.message
          : String(signal.reason ?? "aborted");
        throw latchFatal(
          `Collector observe failed: ${abortMessage}`,
          signal.reason,
        );
      }
      const observedAt = clock.wallNow().toISOString();
      const cutoff = pastCutoff(clock);
      if (cutoff) {
        finalObservationRequired = true;
      }

      let surfaces;
      try {
        surfaces = await fetchObserveSurfaces(transport, observedAt, signal);
        if (prIdentity(surfaces.prInitial) !== prIdentity(surfaces.prTerminal)) {
          // Retry full surfaces once; bind only a consistent terminal read.
          surfaces = await fetchObserveSurfaces(transport, observedAt, signal);
          if (prIdentity(surfaces.prInitial) !== prIdentity(surfaces.prTerminal)) {
            throw new Error(
              `PR identity drifted across observe bracket after retry (${prIdentity(surfaces.prInitial)} → ${prIdentity(surfaces.prTerminal)})`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown failure";
        throw latchFatal(`Collector observe failed: ${message}`, error);
      }

      // First-sighting trust must not predate actual surface observation.
      // Observe-start may be before cutoff while surfaces arrive after; stamp
      // evidence wall metadata and mono trust only once surfaces are in hand
      // (budget retain during fetch may keep the temporary start stamp).
      const firstObservedAt = clock.wallNow().toISOString(); // metadata
      const firstObservedMono = monoNowOrThrow(clock); // trust

      // Always bind terminal PR identity fields.
      const pr = surfaces.prTerminal;
      const { user, reviews, reactions, issueComments, reviewComments } = surfaces;

      requesterLogin = user.login.toLowerCase();

      const pageDiagnostics: GitHubPageDiagnostics[] = [
        ...reviews.pages,
        ...reactions.pages,
        ...issueComments.pages,
        ...reviewComments.pages,
      ];

      const pendingRecords: CollectorEvidenceRecord[] = [];
      pendingRecords.push(normalizeAuthenticatedUserEvidence(user, firstObservedAt));
      pendingRecords.push(normalizePullRequestEvidence(pr, firstObservedAt));
      for (const review of reviews.items) {
        pendingRecords.push(normalizeReviewEvidence(review, firstObservedAt));
      }
      for (const reaction of reactions.items) {
        pendingRecords.push(normalizePullRequestReactionEvidence(reaction, firstObservedAt));
      }
      for (const comment of issueComments.items) {
        pendingRecords.push(normalizeIssueCommentEvidence(comment, firstObservedAt));
      }
      for (const comment of reviewComments.items) {
        pendingRecords.push(normalizeReviewCommentEvidence(comment, firstObservedAt));
      }

      applyEvidenceVersionHistory(
        pendingRecords,
        [...evidenceById.values()],
        { deadlineMono: deadlineMono!, firstObservedMono },
      );
      assignWindowRelations(pendingRecords, activationTime, deadlineTime);

      const normalizedByteLength = measureNormalizedBytes(pendingRecords);

      // Commit only after complete surfaces validated.
      const storedIds: string[] = [];
      for (const record of pendingRecords) {
        const stored = storeEvidence(record);
        storedIds.push(stored.evidenceId);
      }
      // Project modelView from canonical stored snapshot records (not mutable pending).
      const storedRecords = storedIds.map((id) => {
        const stored = evidenceById.get(id);
        if (stored === undefined) {
          throw latchFatal(`Collector observe lost stored evidence ${id}`);
        }
        return stored;
      });

      const completedAt = clock.wallNow().toISOString();
      const completedMono = clock.monoNow();
      const snapshotId = sha256Text(
        `${completedAt}:${pr.headOid}:${storedIds.join(",")}`,
      ).slice(0, 16);

      // Recover ambiguous request markers if present.
      for (const failure of transportFailures) {
        if (failure.recovered || failure.kind !== "ambiguous_request_loss") continue;
        if (failure.marker === undefined || failure.requestId === undefined) continue;
        const found = storedRecords.find((record) =>
          record.kind === "issue_comment" &&
          record.authorLogin === requesterLogin &&
          typeof record.body === "string" &&
          record.body.includes(failure.marker!)
        );
        if (found) {
          failure.recovered = true;
          const attempt = attempts.find((item) =>
            item.status === "ambiguous_loss" &&
            item.requestId === failure.requestId &&
            item.marker === failure.marker
          );
          if (attempt) {
            attempt.status = "recovered";
            attempt.commentEvidenceId = found.evidenceId;
            attempt.recoverySnapshotId = snapshotId;
          }
        }
      }

      const snapshot: CollectorSnapshot = {
        snapshotId,
        observedAt,
        completedAt,
        completedMono,
        host: "github.com",
        repository: config.repository.canonical,
        prNumber: config.prNumber,
        prState: pr.state,
        headOid: pr.headOid,
        complete: true,
        evidenceIds: storedIds,
        pageDiagnostics,
        normalizedByteLength,
      };
      snapshots.push(snapshot);
      latestCompleteSnapshotId = snapshotId;
      observedGeneration = mutationGeneration;
      if (finalObservationRequired && completedMono >= (deadlineMono ?? 0)) {
        finalObservationCompleted = true;
      } else if (cutoff) {
        finalObservationCompleted = true;
      }

      const modelView = buildObserveModelView({
        snapshot,
        records: storedRecords,
        requesterLogin,
        attempts,
      });

      return { snapshot, modelView };
    },

    async request(input, transport, clock, signal) {
      assertNotFatal();
      if (activationTime === undefined || deadlineTime === undefined) {
        throw latchFatal("Collector request requires activation");
      }
      if (pastCutoff(clock)) {
        finalObservationRequired = true;
        throw latchFatal("Collector request is not permitted at or after the eligibility cutoff");
      }
      if (ledger.unresolvedTransportFailure) {
        throw latchFatal("Collector cannot request while a transport failure is unrecovered");
      }

      const request = config.manifest.requests.find((item) => item.id === input.requestId);
      if (request === undefined) {
        throw new Error(`Unknown Collector requestId "${input.requestId}"`);
      }

      const snapshot = snapshots.find((item) => item.snapshotId === input.snapshotId);
      if (snapshot === undefined) {
        throw new Error(`Unknown Collector snapshotId \"${input.snapshotId}\"`);
      }
      if (snapshot.snapshotId !== latestCompleteSnapshotId) {
        throw new Error("Collector request requires the latest complete snapshot");
      }
      if (snapshot.prState !== "OPEN") {
        throw latchFatal("Collector cannot request on a non-OPEN pull request snapshot");
      }

      const { body, marker } = buildCollectorRequestBody({
        configuredBody: request.requestBody,
        manifestDigest: config.manifest.digest,
        requestId: request.id,
        headOid: snapshot.headOid,
      });
      const existingMarker = snapshot.evidenceIds.some((id) => {
        const record = evidenceById.get(id);
        return record?.kind === "issue_comment" &&
          record.authorLogin === requesterLogin &&
          typeof record.body === "string" &&
          record.body.includes(marker);
      });
      if (existingMarker) {
        throw new Error(
          `Collector already has an authenticated same-marker request for request \"${input.requestId}\" at this HEAD`,
        );
      }

      const attemptKey = [
        config.repository.canonical,
        String(config.prNumber),
        snapshot.headOid,
        request.id,
      ].join("|");
      if (attemptKeys.has(attemptKey)) {
        throw new Error(
          `Collector process-local request attempt already used for request \"${request.id}\" at HEAD ${snapshot.headOid}`,
        );
      }

      const startedAt = clock.wallNow().toISOString();
      const attemptId = sha256Text(`${attemptKey}:${startedAt}`).slice(0, 16);
      const attempt: CollectorRequestAttempt = {
        attemptId,
        requestId: request.id,
        observedHead: snapshot.headOid,
        snapshotId: snapshot.snapshotId,
        marker,
        body,
        startedAt,
        status: "started",
      };
      attempts.push(attempt);
      attemptKeys.add(attemptKey);

      const result = await transport.createIssueComment({
        owner: config.repository.owner,
        repo: config.repository.repo,
        prNumber: config.prNumber,
        body,
        ...(signal === undefined ? {} : { signal }),
      });

      // Successful or ambiguous request completion dirties observation generation.
      mutationGeneration += 1;
      finalObservationCompleted = false;

      if (result.kind === "success") {
        const record = storeEvidence(
          normalizeIssueCommentEvidence(result.comment, startedAt),
        );
        attempt.status = "succeeded";
        attempt.commentEvidenceId = record.evidenceId;
        return {
          status: "succeeded",
          attemptId,
          requestId: request.id,
          observedHead: snapshot.headOid,
          marker,
          commentEvidenceId: record.evidenceId,
        };
      }

      if (result.kind === "ambiguous_loss") {
        attempt.status = "ambiguous_loss";
        attempt.responseDiagnostics = result.diagnostics;
        transportFailures.push({
          failureId: sha256Text(`loss:${attemptId}`).slice(0, 16),
          kind: "ambiguous_request_loss",
          message: result.diagnostics,
          requestId: request.id,
          observedHead: snapshot.headOid,
          marker,
          recovered: false,
        });
        return {
          status: "ambiguous_loss",
          attemptId,
          requestId: request.id,
          observedHead: snapshot.headOid,
          marker,
          diagnostics: result.diagnostics,
        };
      }

      attempt.status = "rejected";
      attempt.responseDiagnostics = result.diagnostics;
      throw latchFatal(
        `Collector request rejected: ${result.diagnostics}`,
      );
    },

    async wait(input, clock, signal) {
      assertNotFatal();
      if (activationTime === undefined) {
        throw latchFatal("Collector wait requires activation");
      }
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1) {
        throw new Error("Collector wait durationMs must be a positive safe integer");
      }
      if (input.durationMs > COLLECTOR_ELIGIBILITY_MS) {
        throw new Error(
          `Collector wait durationMs must be at most ${COLLECTOR_ELIGIBILITY_MS}`,
        );
      }
      if (pastCutoff(clock)) {
        finalObservationRequired = true;
        throw latchFatal("Collector wait is not permitted at or after the eligibility cutoff");
      }

      const remaining = remainingMs(clock);
      // Single-wait runtime cadence cap (v2 §6 / §9); schema max stays 15m.
      const COLLECTOR_SINGLE_WAIT_MAX_MS = 300_000;
      const effectiveMs = Math.min(
        input.durationMs,
        remaining,
        COLLECTOR_SINGLE_WAIT_MAX_MS,
      );
      const startedAt = clock.wallNow().toISOString();
      const waitId = sha256Text(`wait:${startedAt}:${effectiveMs}`).slice(0, 16);
      await clock.sleep(effectiveMs, signal);
      const endedAt = clock.wallNow().toISOString();
      const cutoffReached = pastCutoff(clock);
      if (cutoffReached) finalObservationRequired = true;
      mutationGeneration += 1;
      finalObservationCompleted = false;
      const record: CollectorWaitRecord = {
        waitId,
        requestedMs: input.durationMs,
        effectiveMs,
        startedAt,
        endedAt,
        cutoffReached,
      };
      waits.push(record);
      return {
        waitId,
        requestedMs: input.durationMs,
        effectiveMs,
        cutoffReached,
        remainingMsAfter: remainingMs(clock),
      };
    },

    getSnapshot(snapshotId) {
      return snapshots.find((item) => item.snapshotId === snapshotId);
    },
    getEvidence(evidenceId) {
      return evidenceById.get(evidenceId);
    },
    allEvidence() {
      return [...evidenceById.values()];
    },
    allSnapshots() {
      return [...snapshots];
    },
    requestAttempts() {
      return [...attempts];
    },
    waits() {
      return [...waits];
    },
    transportFailures() {
      return [...transportFailures];
    },
    requestById(requestId) {
      return config.manifest.requests.find((request) => request.id === requestId);
    },
  };

  return ledger;
}

function buildObserveModelView(input: {
  snapshot: CollectorSnapshot;
  records: readonly CollectorEvidenceRecord[];
  requesterLogin: string | undefined;
  attempts: readonly CollectorRequestAttempt[];
}): unknown {
  const relevant = input.records;
  return {
    snapshotId: input.snapshot.snapshotId,
    observedAt: input.snapshot.observedAt,
    completedAt: input.snapshot.completedAt,
    prState: input.snapshot.prState,
    headOid: input.snapshot.headOid,
    complete: input.snapshot.complete,
    evidence: relevant.map((record) => ({
      evidenceId: record.evidenceId,
      kind: record.kind,
      authorLogin: record.authorLogin,
      state: record.state,
      body: record.body,
      commitOid: record.commitOid,
      htmlUrl: record.htmlUrl,
      path: record.path,
      // Single display fallback: current line, else originalLine.
      line: record.line ?? record.originalLine,
      side: record.side,
      authoritativeTime: record.authoritativeTime,
      windowRelation: record.windowRelation,
      pullRequestReviewId: record.pullRequestReviewId,
    })),
    requestAttempts: input.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      requestId: attempt.requestId,
      observedHead: attempt.observedHead,
      status: attempt.status,
      marker: attempt.marker,
      recoverySnapshotId: attempt.recoverySnapshotId,
    })),
  };
}
