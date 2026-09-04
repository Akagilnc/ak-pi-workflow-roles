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

export const COLLECTOR_ACTIVATION_ENTRY_TYPE = "ak-collector-activation" as const;
export const COLLECTOR_SNAPSHOT_ENTRY_TYPE = "ak-collector-snapshot" as const;
export const COLLECTOR_REQUEST_ENTRY_TYPE = "ak-collector-request" as const;
export const COLLECTOR_WAIT_ENTRY_TYPE = "ak-collector-wait" as const;

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

export type CollectorLedgerHydrationState = {
  readonly activationTime?: Date | undefined;
  readonly deadlineTime?: Date | undefined;
  readonly snapshots?: readonly CollectorSnapshot[] | undefined;
  readonly evidenceRecords?: readonly CollectorEvidenceRecord[] | undefined;
  readonly requestAttempts?: readonly CollectorRequestAttempt[] | undefined;
  readonly attemptKeys?: Iterable<string> | undefined;
  readonly waits?: readonly CollectorWaitRecord[] | undefined;
  readonly transportFailures?: readonly CollectorTransportFailure[] | undefined;
  readonly mutationGeneration?: number | undefined;
  readonly observedGeneration?: number | undefined;
  readonly latestCompleteSnapshotId?: string | undefined;
  readonly finalObservationRequired?: boolean | undefined;
  readonly finalObservationCompleted?: boolean | undefined;
  readonly outputCandidate?: boolean | undefined;
};

export type CollectorLedger = {
  readonly config: CollectorConfigState;
  readonly fatal: boolean;
  readonly fatalReason: string | undefined;
  readonly outputCandidate: boolean;
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
  recordOutputCandidate(): void;
  beginOperational(toolName: string, toolCallId: string): void;
  completeOperational(toolCallId: string): void;
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

export function createCollectorLedger(
  config: CollectorConfigState,
  hydration?: CollectorLedgerHydrationState,
  clock?: CollectorClock,
): CollectorLedger {
  let fatal = false;
  let fatalReason: string | undefined;
  let outputCandidate = hydration?.outputCandidate ?? false;
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

  if (hydration?.activationTime !== undefined && hydration?.deadlineTime !== undefined) {
    activationTime = hydration.activationTime;
    deadlineTime = hydration.deadlineTime;
    if (clock !== undefined) {
      const wallNow = clock.wallNow().getTime();
      const monoNow = clock.monoNow();
      const elapsedMs = wallNow - activationTime.getTime();
      const remainingMs = deadlineTime.getTime() - wallNow;
      activationMono = monoNow - elapsedMs;
      deadlineMono = monoNow + remainingMs;
    }
  }

  for (const record of hydration?.evidenceRecords ?? []) {
    storeEvidence(record);
  }

  for (const snap of hydration?.snapshots ?? []) {
    const copy: CollectorSnapshot = { ...snap, evidenceIds: [...snap.evidenceIds] };
    if (deadlineTime !== undefined && deadlineMono !== undefined && copy.completedAt !== undefined) {
      const completedWall = new Date(copy.completedAt).getTime();
      copy.completedMono = deadlineMono + (completedWall - deadlineTime.getTime());
    }
    snapshots.push(copy);
  }

  latestCompleteSnapshotId = hydration?.latestCompleteSnapshotId ?? snapshots.at(-1)?.snapshotId;

  for (const att of hydration?.requestAttempts ?? []) {
    attempts.push({ ...att });
    const key = [config.repository.canonical, String(config.prNumber), att.observedHead, att.requestId].join("|");
    attemptKeys.add(key);
  }

  if (hydration?.attemptKeys !== undefined) {
    for (const key of hydration.attemptKeys) {
      attemptKeys.add(key);
    }
  }

  for (const wait of hydration?.waits ?? []) {
    waits.push({ ...wait });
  }

  for (const failure of hydration?.transportFailures ?? []) {
    transportFailures.push({ ...failure });
  }

  if (hydration?.mutationGeneration !== undefined) {
    mutationGeneration = hydration.mutationGeneration;
  }
  if (hydration?.observedGeneration !== undefined) {
    observedGeneration = hydration.observedGeneration;
  }
  if (hydration?.finalObservationRequired !== undefined) {
    finalObservationRequired = hydration.finalObservationRequired;
  }
  if (hydration?.finalObservationCompleted !== undefined) {
    finalObservationCompleted = hydration.finalObservationCompleted;
  }
  if (clock !== undefined && deadlineMono !== undefined && clock.monoNow() >= deadlineMono) {
    finalObservationRequired = true;
    const lastSnap = snapshots.find((item) => item.snapshotId === latestCompleteSnapshotId);
    if (lastSnap?.completedMono !== undefined && lastSnap.completedMono >= deadlineMono) {
      finalObservationCompleted = true;
    }
  }

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
    get outputCandidate() {
      return outputCandidate;
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

    recordOutputCandidate() {
      assertNotFatal();
      outputCandidate = true;
    },

    beginOperational(toolName, toolCallId) {
      assertNotFatal();
      if (outputCandidate && toolName !== COLLECTOR_OUTPUT_TOOL) {
        throw new Error("通进司已产出输出候选，本局不再受理操作");
      }
      // Idempotent for the same call across tool_call preflight and execute.
      if (activeOperationalCallId === toolCallId) {
        return;
      }
      if (activeOperationalCallId !== undefined) {
        throw latchFatal("通进司操作调用已在进行");
      }

      if (toolName === COLLECTOR_OUTPUT_TOOL) {
        return;
      }

      if (!isOperationalTool(toolName)) {
        throw latchFatal(`未知通进司工具 ${toolName}`);
      }
      activeOperationalCallId = toolCallId;
    },

    completeOperational(toolCallId) {
      if (activeOperationalCallId === toolCallId) {
        activeOperationalCallId = undefined;
      }
    },

    noteCutoffObserved() {
      finalObservationRequired = true;
    },

    assertOutputObservationLaw(clock) {
      assertNotFatal();
      if (activationTime === undefined || deadlineTime === undefined || deadlineMono === undefined) {
        throw new Error("通进司回执需要激活时间线");
      }
      if (latestCompleteSnapshotId === undefined) {
        throw new Error("通进司回执需要完整终局快照");
      }
      if (observedGeneration !== mutationGeneration) {
        throw new Error(
          "通进司回执要求在最近 request/wait 变更后完成一次 observe",
        );
      }
      const snapshot = snapshots.find((item) => item.snapshotId === latestCompleteSnapshotId);
      if (snapshot === undefined || !snapshot.complete) {
        throw new Error("通进司终局快照缺失或不完整");
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
            "通进司截止时/后回执要求不早于截止完成的完整观察",
          );
        }
        finalObservationCompleted = true;
      }
    },

    async observe(transport, clock, signal) {
      assertNotFatal();
      if (activationTime === undefined) {
        throw latchFatal("通进司观察需要激活");
      }
      if (signal?.aborted) {
        const abortMessage = signal.reason instanceof Error
          ? signal.reason.message
          : String(signal.reason ?? "已中止");
        throw latchFatal(`通进司观察失败：${abortMessage}`, signal.reason);
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
              `PR 身份在 observe 括弧重试后仍漂移（${prIdentity(surfaces.prInitial)} → ${prIdentity(surfaces.prTerminal)}）`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知失败";
        throw latchFatal(`通进司观察失败：${message}`, error);
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
          throw latchFatal(`通进司观察丢失已存证据 ${id}`);
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
        throw latchFatal("通进司请求需要激活");
      }
      if (pastCutoff(clock)) {
        finalObservationRequired = true;
        throw latchFatal("通进司请求不在资格截止前");
      }
      if (ledger.unresolvedTransportFailure) {
        throw latchFatal("通进司请求时存在未恢复的传输失败");
      }

      const request = config.manifest.requests.find((item) => item.id === input.requestId);
      if (request === undefined) {
        throw new Error(`未知通进司 requestId "${input.requestId}"`);
      }

      const snapshot = snapshots.find((item) => item.snapshotId === input.snapshotId);
      if (snapshot === undefined) {
        throw new Error(`未知通进司 snapshotId "${input.snapshotId}"`);
      }
      if (snapshot.snapshotId !== latestCompleteSnapshotId) {
        throw new Error("通进司请求要求最新完整快照");
      }
      if (snapshot.prState !== "OPEN") {
        throw latchFatal("通进司请求要求 OPEN 状态的 PR 快照");
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
          `通进司在此 HEAD 已有同 marker 的已认证请求 "${input.requestId}"`,
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
          `通进司进程内请求 "${request.id}" 在 HEAD ${snapshot.headOid} 的 attempt 已用`,
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
      throw latchFatal(`通进司请求被拒：${result.diagnostics}`);
    },

    async wait(input, clock, signal) {
      assertNotFatal();
      if (activationTime === undefined) {
        throw latchFatal("通进司等待需要激活");
      }
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 1) {
        throw new Error("通进司等待 durationMs 须为正安全整数");
      }
      if (input.durationMs > COLLECTOR_ELIGIBILITY_MS) {
        throw new Error(
          `通进司等待 durationMs 至多为 ${COLLECTOR_ELIGIBILITY_MS}`,
        );
      }
      if (pastCutoff(clock)) {
        finalObservationRequired = true;
        throw latchFatal("通进司等待不在资格截止前");
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

export function hydrateCollectorLedgerFromSession(
  entries: Iterable<unknown>,
  config: CollectorConfigState,
): CollectorLedgerHydrationState {
  let customActivation: { activationTime: string; deadlineTime: string } | undefined;
  const customSnapshots: CollectorSnapshot[] = [];
  const customEvidence: CollectorEvidenceRecord[] = [];
  const customAttempts: CollectorRequestAttempt[] = [];
  const customAttemptKeys = new Set<string>();
  const customWaits: CollectorWaitRecord[] = [];
  let customMutationGen: number | undefined;
  let customObservedGen: number | undefined;
  let outputCandidate = false;

  let earliestSessionTime: string | undefined;
  const toolSnapshots: CollectorSnapshot[] = [];
  const toolEvidence: CollectorEvidenceRecord[] = [];
  const toolAttempts: CollectorRequestAttempt[] = [];
  const toolAttemptKeys = new Set<string>();
  const toolWaits: CollectorWaitRecord[] = [];

  type OpenToolCall = { name: string; args: any; timestamp?: string | undefined };
  const openCalls = new Map<string, OpenToolCall>();

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;

    if (typeof entry.timestamp === "string" && entry.timestamp) {
      if (!earliestSessionTime || entry.timestamp < earliestSessionTime) {
        earliestSessionTime = entry.timestamp;
      }
    }

    if (entry.type === "custom") {
      const customType = entry.customType;
      const data = entry.data as any;
      if (!data || typeof data !== "object") continue;

      if (customType === "ak-collector-output-candidate") {
        outputCandidate = true;
      } else if (customType === COLLECTOR_ACTIVATION_ENTRY_TYPE) {
        if (typeof data.activationTime === "string" && typeof data.deadlineTime === "string") {
          customActivation = { activationTime: data.activationTime, deadlineTime: data.deadlineTime };
        }
      } else if (customType === COLLECTOR_SNAPSHOT_ENTRY_TYPE) {
        const snap = (data.snapshot && typeof data.snapshot.snapshotId === "string")
          ? data.snapshot
          : (typeof data.snapshotId === "string" ? data : undefined);
        if (snap) {
          customSnapshots.push(snap);
        }
        if (Array.isArray(data.evidence)) {
          customEvidence.push(...data.evidence);
        }
        if (typeof data.mutationGeneration === "number") {
          customMutationGen = Math.max(customMutationGen ?? 0, data.mutationGeneration);
        }
        if (typeof data.observedGeneration === "number") {
          customObservedGen = Math.max(customObservedGen ?? 0, data.observedGeneration);
        }
        if (typeof data.activationTime === "string" && typeof data.deadlineTime === "string" && !customActivation) {
          customActivation = { activationTime: data.activationTime, deadlineTime: data.deadlineTime };
        }
      } else if (customType === COLLECTOR_REQUEST_ENTRY_TYPE) {
        const att = (data.attempt && typeof data.attempt.attemptId === "string")
          ? data.attempt
          : (typeof data.attemptId === "string" ? data : undefined);
        if (att) {
          customAttempts.push(att);
        }
        if (typeof data.attemptKey === "string") {
          customAttemptKeys.add(data.attemptKey);
        }
        if (data.commentEvidence && typeof data.commentEvidence.evidenceId === "string") {
          customEvidence.push(data.commentEvidence);
        }
        if (typeof data.mutationGeneration === "number") {
          customMutationGen = Math.max(customMutationGen ?? 0, data.mutationGeneration);
        }
      } else if (customType === COLLECTOR_WAIT_ENTRY_TYPE) {
        const waitRec = (data.waitRecord && typeof data.waitRecord.waitId === "string")
          ? data.waitRecord
          : (typeof data.waitId === "string" ? data : undefined);
        if (waitRec) {
          customWaits.push(waitRec);
        }
        if (typeof data.mutationGeneration === "number") {
          customMutationGen = Math.max(customMutationGen ?? 0, data.mutationGeneration);
        }
      }
      continue;
    }

    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      if (typeof msg.timestamp === "string" && msg.timestamp) {
        if (!earliestSessionTime || msg.timestamp < earliestSessionTime) {
          earliestSessionTime = msg.timestamp;
        }
      }

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
            openCalls.set(part.id, {
              name: part.name,
              args: part.arguments,
              timestamp: typeof msg.timestamp === "string" ? msg.timestamp : typeof entry.timestamp === "string" ? entry.timestamp : undefined,
            });
          }
        }
      }

      if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
        const toolCall = openCalls.get(msg.toolCallId);
        const toolName = typeof msg.toolName === "string" ? msg.toolName : toolCall?.name;
        const details = msg.details as any;

        if (toolName === COLLECTOR_OBSERVE_TOOL && msg.isError !== true && details && typeof details === "object") {
          if (typeof details.snapshotId === "string" && typeof details.headOid === "string") {
            const evIds: string[] = [];
            if (Array.isArray(details.evidence)) {
              for (const item of details.evidence) {
                if (item && typeof item.evidenceId === "string") {
                  evIds.push(item.evidenceId);
                  toolEvidence.push({
                    evidenceId: item.evidenceId,
                    kind: item.kind ?? "issue_comment",
                    versionId: item.versionId ?? item.evidenceId,
                    contentDigest: item.contentDigest ?? item.evidenceId,
                    firstObservedAt: item.firstObservedAt ?? item.authoritativeTime ?? new Date().toISOString(),
                    raw: item.raw ?? item,
                    authorLogin: item.authorLogin,
                    state: item.state,
                    body: item.body,
                    commitOid: item.commitOid,
                    htmlUrl: item.htmlUrl,
                    path: item.path,
                    line: item.line,
                    side: item.side,
                    authoritativeTime: item.authoritativeTime,
                    windowRelation: item.windowRelation,
                    pullRequestReviewId: item.pullRequestReviewId,
                    githubId: item.githubId,
                    machineIdentity: item.machineIdentity,
                  });
                }
              }
            }
            toolSnapshots.push({
              snapshotId: details.snapshotId,
              observedAt: details.observedAt ?? msg.timestamp ?? entry.timestamp ?? new Date().toISOString(),
              completedAt: details.completedAt ?? msg.timestamp ?? entry.timestamp ?? new Date().toISOString(),
              completedMono: 0,
              host: "github.com",
              repository: config.repository.canonical,
              prNumber: config.prNumber,
              prState: details.prState ?? "OPEN",
              headOid: details.headOid,
              complete: details.complete ?? true,
              evidenceIds: evIds,
              pageDiagnostics: details.pageDiagnostics ?? [],
              normalizedByteLength: details.normalizedByteLength ?? 0,
            });
            if (Array.isArray(details.requestAttempts)) {
              for (const att of details.requestAttempts) {
                if (att && typeof att.attemptId === "string") {
                  toolAttempts.push(att);
                  const k = [config.repository.canonical, String(config.prNumber), att.observedHead ?? details.headOid, att.requestId].join("|");
                  toolAttemptKeys.add(k);
                }
              }
            }
          }
        } else if (toolName === COLLECTOR_REQUEST_TOOL && msg.isError !== true && details && typeof details === "object") {
          const reqId = details.requestId ?? toolCall?.args?.requestId;
          const headOid = details.observedHead;
          if (reqId && headOid) {
            const k = [config.repository.canonical, String(config.prNumber), headOid, reqId].join("|");
            toolAttemptKeys.add(k);
          }
          if (typeof details.attemptId === "string") {
            toolAttempts.push(details);
          }
        } else if (toolName === COLLECTOR_WAIT_TOOL && msg.isError !== true && details && typeof details === "object") {
          if (typeof details.effectiveMs === "number") {
            toolWaits.push(details);
          }
        } else if (toolName === COLLECTOR_OUTPUT_TOOL && msg.isError !== true) {
          outputCandidate = true;
        }
      }
    }
  }

  let activationTime: Date | undefined;
  let deadlineTime: Date | undefined;
  if (customActivation) {
    activationTime = new Date(customActivation.activationTime);
    deadlineTime = new Date(customActivation.deadlineTime);
  } else if (earliestSessionTime) {
    activationTime = new Date(earliestSessionTime);
    deadlineTime = new Date(activationTime.getTime() + COLLECTOR_ELIGIBILITY_MS);
  }

  const snapshots = customSnapshots.length > 0 ? customSnapshots : toolSnapshots;

  const evidenceMap = new Map<string, CollectorEvidenceRecord>();
  for (const ev of customEvidence) evidenceMap.set(ev.evidenceId, ev);
  for (const ev of toolEvidence) {
    if (!evidenceMap.has(ev.evidenceId)) evidenceMap.set(ev.evidenceId, ev);
  }

  const attemptsMap = new Map<string, CollectorRequestAttempt>();
  for (const att of customAttempts) attemptsMap.set(att.attemptId, att);
  for (const att of toolAttempts) {
    if (!attemptsMap.has(att.attemptId)) attemptsMap.set(att.attemptId, att);
  }

  const attemptKeys = new Set<string>([...customAttemptKeys, ...toolAttemptKeys]);
  for (const att of attemptsMap.values()) {
    if (att.observedHead && att.requestId) {
      attemptKeys.add([config.repository.canonical, String(config.prNumber), att.observedHead, att.requestId].join("|"));
    }
  }

  const waits = customWaits.length > 0 ? customWaits : toolWaits;
  const mutationGeneration = customMutationGen ?? (attemptsMap.size > 0 || waits.length > 0 ? Math.max(attemptsMap.size, waits.length) : 0);
  const observedGeneration = customObservedGen ?? (snapshots.length > 0 ? mutationGeneration : 0);

  return {
    activationTime,
    deadlineTime,
    snapshots,
    evidenceRecords: [...evidenceMap.values()],
    requestAttempts: [...attemptsMap.values()],
    attemptKeys,
    waits,
    mutationGeneration,
    observedGeneration,
    latestCompleteSnapshotId: snapshots.at(-1)?.snapshotId,
    outputCandidate,
  };
}
