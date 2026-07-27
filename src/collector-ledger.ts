import type { CollectorManifest, CollectorRepository } from "./collector-config.ts";
import {
  assignWindowRelations,
  COLLECTOR_ELIGIBILITY_MS,
  COLLECTOR_RECEIPT_MAX_BYTES,
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  type CollectorClock,
  type CollectorEvidenceRecord,
  type CollectorSnapshot,
  measureNormalizedBytes,
  normalizeAuthenticatedUserEvidence,
  normalizeIssueCommentEvidence,
  normalizePullRequestEvidence,
  normalizeReviewCommentEvidence,
  normalizeReviewEvidence,
  sha256Text,
} from "./collector-evidence.ts";
import {
  buildCollectorRequestBody,
  type CollectorGitHubTransport,
  type GitHubPageDiagnostics,
} from "./collector-github.ts";

export const COLLECTOR_OBSERVE_TOOL = "ak_collector_observe";
export const COLLECTOR_REQUEST_TOOL = "ak_collector_request";
export const COLLECTOR_WAIT_TOOL = "ak_collector_wait";
export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";

export const COLLECTOR_OPERATIONAL_TOOLS = [
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
] as const;

export type CollectorOperationalTool = (typeof COLLECTOR_OPERATIONAL_TOOLS)[number];

export type CollectorToolCallPart = {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
};

export type CollectorRequestAttempt = {
  attemptId: string;
  legId: string;
  observedHead: string;
  snapshotId: string;
  marker: string;
  body: string;
  startedAt: string;
  status: "started" | "succeeded" | "rejected" | "ambiguous_loss" | "recovered";
  responseDiagnostics?: string;
  commentEvidenceId?: string;
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
  legId?: string;
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

  latchFatal(reason: string): Error;
  assertNotFatal(): void;
  recordActivation(clock: CollectorClock): void;
  evaluateBatch(calls: readonly CollectorToolCallPart[]): { allow: true } | { allow: false; reason: string };
  beginOperational(toolName: string, toolCallId: string): void;
  completeOperational(toolCallId: string): void;
  markOutputAccepted(): void;
  noteCutoffObserved(): void;

  observe(
    transport: CollectorGitHubTransport,
    clock: CollectorClock,
  ): Promise<{
    snapshot: CollectorSnapshot;
    modelView: unknown;
  }>;

  request(
    input: { legId: string; snapshotId: string },
    transport: CollectorGitHubTransport,
    clock: CollectorClock,
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
  configuredAuthorLogins(): ReadonlySet<string>;
  legById(legId: string): CollectorConfigState["manifest"]["legs"][number] | undefined;
  materializationByteLength(): number;
  assertMaterializationWithinBound(label: string): void;
};

function isOperationalTool(name: string): name is CollectorOperationalTool {
  return (COLLECTOR_OPERATIONAL_TOOLS as readonly string[]).includes(name);
}

function isCollectorTool(name: string): boolean {
  return isOperationalTool(name) || name === COLLECTOR_OUTPUT_TOOL;
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
  let lastAssistantBatchKey: string | undefined;
  let lastAssistantBatchFatal = false;
  let operationalCompletedSinceOutputPermit = false;

  const evidenceById = new Map<string, CollectorEvidenceRecord>();
  const evidenceByVersion = new Map<string, string>();
  const snapshots: CollectorSnapshot[] = [];
  const attempts: CollectorRequestAttempt[] = [];
  const attemptKeys = new Set<string>();
  const waits: CollectorWaitRecord[] = [];
  const transportFailures: CollectorTransportFailure[] = [];

  const configuredAuthors = new Set<string>();
  for (const leg of config.manifest.legs) {
    for (const author of leg.expectedAuthors) configuredAuthors.add(author);
  }

  const latchFatal = (reason: string): Error => {
    fatal = true;
    fatalReason = reason;
    const error = new Error(reason);
    Object.assign(error, { collectorFatal: true });
    return error;
  };

  const assertNotFatal = (): void => {
    if (fatal) throw new Error(fatalReason ?? "Collector is in fatal state");
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

  const materializationByteLength = (): number => {
    const payload = {
      evidence: [...evidenceById.values()],
      snapshots,
      attempts,
      waits,
      transportFailures,
    };
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  };

  const assertMaterializationWithinBound = (label: string): void => {
    const bytes = materializationByteLength();
    if (bytes > COLLECTOR_RECEIPT_MAX_BYTES) {
      throw latchFatal(
        `Collector ${label} exceeded ${COLLECTOR_RECEIPT_MAX_BYTES} UTF-8 bytes (${bytes})`,
      );
    }
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

    evaluateBatch(calls) {
      assertNotFatal();
      const collectorCalls = calls.filter((call) => isCollectorTool(call.name));
      const operational = collectorCalls.filter((call) => isOperationalTool(call.name));
      const outputs = collectorCalls.filter((call) => call.name === COLLECTOR_OUTPUT_TOOL);
      const key = calls.map((call) => `${call.id}:${call.name}`).join("|");
      lastAssistantBatchKey = key;

      const legalOperational =
        operational.length === 1 && outputs.length === 0 && collectorCalls.length === 1;
      const legalOutput =
        outputs.length === 1 && operational.length === 0 && collectorCalls.length === 1;

      if (legalOperational) {
        lastAssistantBatchFatal = false;
        return { allow: true };
      }
      if (legalOutput) {
        if (!operationalCompletedSinceOutputPermit && snapshots.length === 0) {
          lastAssistantBatchFatal = true;
          return {
            allow: false,
            reason:
              "Collector output requires a prior completed operational result in this invocation",
          };
        }
        lastAssistantBatchFatal = false;
        return { allow: true };
      }

      lastAssistantBatchFatal = true;
      const reason =
        "Collector permits exactly one operational call (observe|request|wait) per assistant batch, or a sole later output call";
      latchFatal(reason);
      return { allow: false, reason };
    },

    beginOperational(toolName, toolCallId) {
      assertNotFatal();
      if (lastAssistantBatchFatal) {
        throw latchFatal("Collector rejected the assistant batch before execution");
      }
      if (outputAccepted) {
        throw latchFatal("Collector output already accepted; no further operations");
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
        operationalCompletedSinceOutputPermit = true;
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

    async observe(transport, clock) {
      assertNotFatal();
      if (activationTime === undefined) {
        throw latchFatal("Collector observe requires activation");
      }
      const observedAt = clock.wallNow().toISOString();
      const cutoff = pastCutoff(clock);
      if (cutoff) {
        finalObservationRequired = true;
      }

      const owner = config.repository.owner;
      const repo = config.repository.repo;
      const prNumber = config.prNumber;

      let user;
      let pr;
      let reviews;
      let issueComments;
      let reviewComments;
      try {
        user = await transport.getAuthenticatedUser();
        pr = await transport.getPullRequest({ owner, repo, prNumber });
        reviews = await transport.listPullRequestReviews({ owner, repo, prNumber });
        issueComments = await transport.listIssueComments({ owner, repo, prNumber });
        reviewComments = await transport.listReviewComments({ owner, repo, prNumber });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw latchFatal(`Collector observe failed: ${message}`);
      }

      requesterLogin = user.login.toLowerCase();

      const pageDiagnostics: GitHubPageDiagnostics[] = [
        ...reviews.pages,
        ...issueComments.pages,
        ...reviewComments.pages,
      ];

      const pendingRecords: CollectorEvidenceRecord[] = [];
      pendingRecords.push(normalizeAuthenticatedUserEvidence(user, observedAt));
      pendingRecords.push(normalizePullRequestEvidence(pr, observedAt));
      for (const review of reviews.items) {
        pendingRecords.push(normalizeReviewEvidence(review, observedAt));
      }
      for (const comment of issueComments.items) {
        pendingRecords.push(normalizeIssueCommentEvidence(comment, observedAt));
      }
      for (const comment of reviewComments.items) {
        pendingRecords.push(normalizeReviewCommentEvidence(comment, observedAt));
      }

      assignWindowRelations(pendingRecords, activationTime, deadlineTime);

      const normalizedByteLength = measureNormalizedBytes(pendingRecords);
      if (normalizedByteLength > COLLECTOR_SNAPSHOT_MAX_BYTES) {
        throw latchFatal(
          `Collector snapshot exceeded ${COLLECTOR_SNAPSHOT_MAX_BYTES} UTF-8 bytes (${normalizedByteLength})`,
        );
      }

      // Commit only after complete surfaces validated.
      const storedIds: string[] = [];
      for (const record of pendingRecords) {
        const stored = storeEvidence(record);
        storedIds.push(stored.evidenceId);
      }

      // Recover ambiguous request markers if present.
      for (const failure of transportFailures) {
        if (failure.recovered || failure.kind !== "ambiguous_request_loss") continue;
        if (failure.marker === undefined || failure.legId === undefined) continue;
        const found = pendingRecords.find((record) =>
          record.kind === "issue_comment" &&
          record.authorLogin === requesterLogin &&
          typeof record.body === "string" &&
          record.body.includes(failure.marker!)
        );
        if (found) {
          failure.recovered = true;
          const attempt = attempts.find((item) =>
            item.status === "ambiguous_loss" &&
            item.legId === failure.legId &&
            item.marker === failure.marker
          );
          if (attempt) {
            attempt.status = "recovered";
            attempt.commentEvidenceId = found.evidenceId;
          }
        }
      }

      const snapshotId = sha256Text(
        `${observedAt}:${pr.headOid}:${storedIds.join(",")}`,
      ).slice(0, 16);
      const snapshot: CollectorSnapshot = {
        snapshotId,
        observedAt,
        host: "github.com",
        repository: config.repository.canonical,
        prNumber,
        prState: pr.state,
        headOid: pr.headOid,
        complete: true,
        evidenceIds: storedIds,
        pageDiagnostics,
        normalizedByteLength,
      };
      snapshots.push(snapshot);
      latestCompleteSnapshotId = snapshotId;
      if (finalObservationRequired) {
        finalObservationCompleted = true;
      }
      // Request/wait invalidate finality only when performed after this; observe refreshes latest.
      assertMaterializationWithinBound("invocation ledger");

      const modelView = buildObserveModelView({
        snapshot,
        records: pendingRecords,
        configuredAuthors,
        requesterLogin,
        attempts,
      });

      return { snapshot, modelView };
    },

    async request(input, transport, clock) {
      assertNotFatal();
      if (activationTime === undefined) {
        throw latchFatal("Collector request requires activation");
      }
      if (pastCutoff(clock)) {
        finalObservationRequired = true;
        throw latchFatal("Collector request is not permitted at or after the eligibility cutoff");
      }
      if (ledger.unresolvedTransportFailure) {
        throw latchFatal("Collector cannot request while a transport failure is unrecovered");
      }

      const leg = config.manifest.legs.find((item) => item.id === input.legId);
      if (leg === undefined) {
        throw new Error(`Unknown Collector legId \"${input.legId}\"`);
      }
      if (leg.requestBody === undefined) {
        throw new Error(`Collector leg \"${input.legId}\" is observe-only and cannot request`);
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

      // Existing exact-head qualifying review means no request (objective precheck).
      const expected = new Set(leg.expectedAuthors);
      const hasQualifying = snapshot.evidenceIds.some((id) => {
        const record = evidenceById.get(id);
        if (record === undefined || record.kind !== "review") return false;
        if (record.authorLogin === undefined || !expected.has(record.authorLogin)) return false;
        if (
          record.state !== "APPROVED" &&
          record.state !== "CHANGES_REQUESTED" &&
          record.state !== "COMMENTED"
        ) {
          return false;
        }
        return record.commitOid === snapshot.headOid;
      });
      if (hasQualifying) {
        throw new Error(
          `Collector leg \"${input.legId}\" already has an exact-head qualifying review; request refused`,
        );
      }

      // Authenticated same-marker request already present => no duplicate.
      const { body, marker } = buildCollectorRequestBody({
        configuredBody: leg.requestBody,
        manifestDigest: config.manifest.digest,
        legId: leg.id,
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
          `Collector already has an authenticated same-marker request for leg \"${input.legId}\" at this HEAD`,
        );
      }

      const attemptKey = [
        config.repository.canonical,
        String(config.prNumber),
        snapshot.headOid,
        leg.id,
      ].join("|");
      if (attemptKeys.has(attemptKey)) {
        throw new Error(
          `Collector process-local request attempt already used for leg \"${leg.id}\" at HEAD ${snapshot.headOid}`,
        );
      }

      const startedAt = clock.wallNow().toISOString();
      const attemptId = sha256Text(`${attemptKey}:${startedAt}`).slice(0, 16);
      const attempt: CollectorRequestAttempt = {
        attemptId,
        legId: leg.id,
        observedHead: snapshot.headOid,
        snapshotId: snapshot.snapshotId,
        marker,
        body,
        startedAt,
        status: "started",
      };
      attempts.push(attempt);
      attemptKeys.add(attemptKey);
      // Request invalidates finality.
      finalObservationCompleted = false;

      const result = await transport.createIssueComment({
        owner: config.repository.owner,
        repo: config.repository.repo,
        prNumber: config.prNumber,
        body,
      });

      if (result.kind === "success") {
        const record = storeEvidence(
          normalizeIssueCommentEvidence(result.comment, startedAt),
        );
        attempt.status = "succeeded";
        attempt.commentEvidenceId = record.evidenceId;
        assertMaterializationWithinBound("invocation ledger");
        return {
          status: "succeeded",
          attemptId,
          legId: leg.id,
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
          legId: leg.id,
          observedHead: snapshot.headOid,
          marker,
          recovered: false,
        });
        assertMaterializationWithinBound("invocation ledger");
        return {
          status: "ambiguous_loss",
          attemptId,
          legId: leg.id,
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
      const effectiveMs = Math.min(input.durationMs, remaining);
      const startedAt = clock.wallNow().toISOString();
      const waitId = sha256Text(`wait:${startedAt}:${effectiveMs}`).slice(0, 16);
      finalObservationCompleted = false;
      await clock.sleep(effectiveMs, signal);
      const endedAt = clock.wallNow().toISOString();
      const cutoffReached = pastCutoff(clock);
      if (cutoffReached) finalObservationRequired = true;
      const record: CollectorWaitRecord = {
        waitId,
        requestedMs: input.durationMs,
        effectiveMs,
        startedAt,
        endedAt,
        cutoffReached,
      };
      waits.push(record);
      assertMaterializationWithinBound("invocation ledger");
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
    configuredAuthorLogins() {
      return configuredAuthors;
    },
    legById(legId) {
      return config.manifest.legs.find((leg) => leg.id === legId);
    },
    materializationByteLength,
    assertMaterializationWithinBound,
  };

  // silence unused in case
  void lastAssistantBatchKey;
  return ledger;
}

function buildObserveModelView(input: {
  snapshot: CollectorSnapshot;
  records: readonly CollectorEvidenceRecord[];
  configuredAuthors: ReadonlySet<string>;
  requesterLogin: string | undefined;
  attempts: readonly CollectorRequestAttempt[];
}): unknown {
  const relevant = input.records.filter((record) => {
    if (record.kind === "pull_request" || record.kind === "authenticated_user") return true;
    if (record.authorLogin !== undefined && input.configuredAuthors.has(record.authorLogin)) {
      return true;
    }
    if (
      record.kind === "issue_comment" &&
      record.authorLogin === input.requesterLogin &&
      typeof record.body === "string" &&
      record.body.includes("ak-collector:v1")
    ) {
      return true;
    }
    return false;
  });

  return {
    snapshotId: input.snapshot.snapshotId,
    observedAt: input.snapshot.observedAt,
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
      line: record.line,
      side: record.side,
      authoritativeTime: record.authoritativeTime,
      windowRelation: record.windowRelation,
      pullRequestReviewId: record.pullRequestReviewId,
    })),
    requestAttempts: input.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      legId: attempt.legId,
      observedHead: attempt.observedHead,
      status: attempt.status,
      marker: attempt.marker,
    })),
  };
}
