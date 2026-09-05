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
  type HeadRelation,
  type WindowRelation,
} from "./collector-evidence.ts";
import {
  buildCollectorRequestBody,
  type CollectorGitHubTransport,
  type GitHubPageDiagnostics,
  type GitHubPullRequest,
} from "./collector-github.ts";
import { CollectorNonOpenRequestError } from "./collector-identity.ts";
import {
  collectorObserveArgsSchema,
  collectorOutputArgsSchema,
  collectorReadArgsSchema,
  collectorRequestArgsSchema,
  collectorWaitArgsSchema,
} from "./collector-tool-schemas.ts";
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";

export const COLLECTOR_OBSERVE_TOOL = "ak_collector_observe";
export const COLLECTOR_READ_TOOL = "ak_collector_read";
export const COLLECTOR_REQUEST_TOOL = "ak_collector_request";
export const COLLECTOR_WAIT_TOOL = "ak_collector_wait";
export { COLLECTOR_OUTPUT_TOOL };

export const COLLECTOR_OPERATIONAL_TOOLS = [
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_READ_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
] as const;

/**
 * #641 chain①: observe context projects at most this many bytes of each
 * material body; the full body stays reachable via the record pointer
 * (evidenceId + htmlUrl) and is preserved in the volume, never unconditionally
 * transcribed into model context or receipt.
 */
export const COLLECTOR_OBSERVE_BODY_HEAD_BYTES = 512;

function utf8SafePrefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

export type ObserveEvidenceEntry = {
  evidenceId: string;
  kind: string;
  authorLogin?: string | undefined;
  state?: string | undefined;
  body?: string | undefined;
  commitOid?: string | null | undefined;
  htmlUrl?: string | undefined;
  path?: string | undefined;
  line?: number | null | undefined;
  side?: string | null | undefined;
  authoritativeTime?: string | null | undefined;
  windowRelation?: WindowRelation | undefined;
  pullRequestReviewId?: number | null | undefined;
};

export type ObserveModelView = {
  snapshotId: string;
  observedAt: string;
  completedAt: string;
  prState: string;
  headOid: string;
  complete: boolean;
  evidence: ObserveEvidenceEntry[];
  requestAttempts: Array<{
    attemptId: string;
    requestId: string;
    observedHead: string;
    status: string;
    marker: string;
    recoverySnapshotId?: string | undefined;
  }>;
};

/**
 * #641 chain① model-context projection: identical shape to the volume view,
 * with every material body bounded to a head preview. Full bodies remain
 * pointer-reachable (evidenceId/htmlUrl) and stay in the ledger volume
 * (collector-side; provider-visible observe details carry only this bounded
 * projection), never unconditionally transcribed into model context.
 */
export function projectObserveContextView(modelView: ObserveModelView): ObserveModelView {
  return {
    ...modelView,
    evidence: modelView.evidence.map((entry) =>
      entry.body === undefined
        ? entry
        : { ...entry, body: utf8SafePrefix(entry.body, COLLECTOR_OBSERVE_BODY_HEAD_BYTES) }),
  };
}

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

/** Durable session journal sink owned by the shared execution seam. */
export type CollectorDurableJournal = {
  append(customType: string, data: unknown): void;
};

export type CollectorLedgerOptions = {
  readonly clock?: CollectorClock | undefined;
  readonly journal?: CollectorDurableJournal | undefined;
  /** Prior dossier custom entries; replayed in order through live business transitions. */
  readonly dossierEntries?: Iterable<unknown> | undefined;
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
    contextView: ObserveModelView;
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
    case COLLECTOR_READ_TOOL:
      return Value.Check(collectorReadArgsSchema, args);
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
  options?: CollectorLedgerOptions,
): CollectorLedger {
  const clock = options?.clock;
  const journal = options?.journal;
  let fatal = false;
  let fatalReason: string | undefined;
  let outputCandidate = false;
  let pendingOutputCallId: string | undefined;
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


  const appendJournal = (customType: string, data: unknown): void => {
    journal?.append(customType, data);
  };

  const bindDeadlineMonoFromWall = (): void => {
    if (clock === undefined || activationTime === undefined || deadlineTime === undefined) return;
    const wallNow = clock.wallNow().getTime();
    const monoNow = clock.monoNow();
    activationMono = monoNow - (wallNow - activationTime.getTime());
    deadlineMono = monoNow + (deadlineTime.getTime() - wallNow);
  };

  const rebindSnapshotCompletedMono = (snapshot: CollectorSnapshot): CollectorSnapshot => {
    const copy: CollectorSnapshot = { ...snapshot, evidenceIds: [...snapshot.evidenceIds] };
    if (deadlineTime !== undefined && deadlineMono !== undefined && copy.completedAt !== undefined) {
      const completedWall = new Date(copy.completedAt).getTime();
      copy.completedMono = deadlineMono + (completedWall - deadlineTime.getTime());
    }
    return copy;
  };

  const commitActivationWindow = (nextActivation: Date, nextDeadline: Date): void => {
    if (activationTime !== undefined) return;
    activationTime = nextActivation;
    deadlineTime = nextDeadline;
    bindDeadlineMonoFromWall();
  };

  const recoverAmbiguousRequestLosses = (
    snapshotId: string,
    observedRecords: readonly CollectorEvidenceRecord[],
  ): void => {
    for (const failure of transportFailures) {
      if (failure.recovered || failure.kind !== "ambiguous_request_loss") continue;
      if (failure.marker === undefined || failure.requestId === undefined) continue;
      const found = observedRecords.find((record) =>
        record.kind === "issue_comment" &&
        record.authorLogin === requesterLogin &&
        typeof record.body === "string" &&
        record.body.includes(failure.marker!)
      );
      if (found === undefined) continue;
      failure.recovered = true;
      const attempt = attempts.find((item) =>
        item.status === "ambiguous_loss" &&
        item.requestId === failure.requestId &&
        item.marker === failure.marker
      );
      if (attempt !== undefined) {
        attempt.status = "recovered";
        attempt.commentEvidenceId = found.evidenceId;
        attempt.recoverySnapshotId = snapshotId;
      }
    }
  };

  const finalizeObservedSnapshot = (snapshot: CollectorSnapshot): CollectorSnapshot => {
    if (requesterLogin === undefined) {
      for (const id of snapshot.evidenceIds) {
        const record = evidenceById.get(id);
        if (record?.kind === "authenticated_user" && record.authorLogin !== undefined) {
          requesterLogin = record.authorLogin.toLowerCase();
          break;
        }
      }
    }
    const stored = rebindSnapshotCompletedMono(snapshot);
    snapshots.push(stored);
    latestCompleteSnapshotId = stored.snapshotId;
    const observedRecords = stored.evidenceIds.flatMap((id) => {
      const record = evidenceById.get(id);
      return record === undefined ? [] : [record];
    });
    recoverAmbiguousRequestLosses(stored.snapshotId, observedRecords);
    observedGeneration = mutationGeneration;
    if (
      finalObservationRequired &&
      stored.completedMono !== undefined &&
      deadlineMono !== undefined &&
      stored.completedMono >= deadlineMono
    ) {
      finalObservationCompleted = true;
    } else if (
      clock !== undefined &&
      deadlineMono !== undefined &&
      clock.monoNow() >= deadlineMono &&
      stored.completedMono !== undefined &&
      stored.completedMono >= deadlineMono
    ) {
      finalObservationRequired = true;
      finalObservationCompleted = true;
    }
    return stored;
  };

  const commitObservedSnapshot = (
    snapshot: CollectorSnapshot,
    evidenceRecords: readonly CollectorEvidenceRecord[],
  ): CollectorSnapshot => {
    for (const record of evidenceRecords) {
      storeEvidence(record);
    }
    return finalizeObservedSnapshot(snapshot);
  };

  const commitRequestAttempt = (
    attempt: CollectorRequestAttempt,
    attemptKey: string,
    commentEvidence: CollectorEvidenceRecord | undefined,
  ): void => {
    if (commentEvidence !== undefined) {
      storeEvidence(commentEvidence);
    }
    const existing = attempts.find((item) => item.attemptId === attempt.attemptId);
    if (existing === undefined) {
      attempts.push({ ...attempt });
      attemptKeys.add(attemptKey);
    } else {
      Object.assign(existing, attempt);
    }
    if (attempt.status === "ambiguous_loss" && !transportFailures.some((failure) => failure.requestId === attempt.requestId && failure.observedHead === attempt.observedHead)) {
      transportFailures.push({
        failureId: sha256Text(`loss:${attempt.attemptId}`).slice(0, 16),
        kind: "ambiguous_request_loss",
        message: attempt.responseDiagnostics ?? "ambiguous request loss",
        requestId: attempt.requestId,
        observedHead: attempt.observedHead,
        marker: attempt.marker,
        recovered: false,
      });
    }
    if (attempt.status === "succeeded" || attempt.status === "ambiguous_loss") {
      mutationGeneration += 1;
      finalObservationCompleted = false;
    }
  };

  const commitWaitRecord = (wait: CollectorWaitRecord): void => {
    waits.push({ ...wait });
    if (wait.cutoffReached) finalObservationRequired = true;
    mutationGeneration += 1;
    finalObservationCompleted = false;
  };

  const replayDossierEntries = (entries: Iterable<unknown>): void => {
    const orderedEntries = Array.from(entries);
    const finalRequestStatus = new Map<string, CollectorRequestAttempt["status"]>();
    for (const raw of orderedEntries) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== "custom" || entry.customType !== COLLECTOR_REQUEST_ENTRY_TYPE || typeof entry.data !== "object" || entry.data === null) continue;
      const attempt = (entry.data as Record<string, unknown>).attempt as CollectorRequestAttempt | undefined;
      if (attempt?.attemptId !== undefined) finalRequestStatus.set(attempt.attemptId, attempt.status);
    }
    for (const raw of orderedEntries) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
      const data = entry.data as Record<string, unknown>;
      if (entry.customType === COLLECTOR_ACTIVATION_ENTRY_TYPE) {
        if (typeof data.activationTime === "string" && typeof data.deadlineTime === "string") {
          commitActivationWindow(new Date(data.activationTime), new Date(data.deadlineTime));
        }
        continue;
      }
      if (entry.customType === COLLECTOR_SNAPSHOT_ENTRY_TYPE) {
        const snapshot = data.snapshot as CollectorSnapshot | undefined;
        if (snapshot?.snapshotId === undefined || !Array.isArray(data.evidence)) continue;
        // Generations advance only via request/wait commits and observation sync — never from collection sizes or payload counters.
        commitObservedSnapshot(snapshot, data.evidence as CollectorEvidenceRecord[]);
        continue;
      }
      if (entry.customType === COLLECTOR_REQUEST_ENTRY_TYPE) {
        const attempt = data.attempt as CollectorRequestAttempt | undefined;
        if (attempt?.attemptId === undefined) continue;
        const attemptKey = typeof data.attemptKey === "string"
          ? data.attemptKey
          : [config.repository.canonical, String(config.prNumber), attempt.observedHead, attempt.requestId].join("|");
        const commentEvidence = data.commentEvidence as CollectorEvidenceRecord | undefined;
        const replayAttempt = attempt.status === "started" && finalRequestStatus.get(attempt.attemptId) === "started"
          ? {
            ...attempt,
            status: "ambiguous_loss" as const,
            responseDiagnostics: "request interrupted after dispatch before completion was recorded",
          }
          : attempt;
        commitRequestAttempt(replayAttempt, attemptKey, commentEvidence);
        continue;
      }
      if (entry.customType === COLLECTOR_WAIT_ENTRY_TYPE) {
        const wait = data.waitRecord as CollectorWaitRecord | undefined;
        if (wait?.waitId === undefined) continue;
        commitWaitRecord(wait);
      }
    }
  };

  if (options?.dossierEntries !== undefined) {
    replayDossierEntries(options.dossierEntries);
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
      return outputCandidate || pendingOutputCallId !== undefined;
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
      appendJournal(COLLECTOR_ACTIVATION_ENTRY_TYPE, {
        activationTime: activationTime.toISOString(),
        deadlineTime: deadlineTime.toISOString(),
      });
    },

    recordOutputCandidate() {
      assertNotFatal();
      outputCandidate = true;
    },

    beginOperational(toolName, toolCallId) {
      assertNotFatal();
      if (
        toolName !== COLLECTOR_OUTPUT_TOOL &&
        (outputCandidate || pendingOutputCallId !== undefined)
      ) {
        throw new Error("通进司已产出输出候选，本局不再受理操作");
      }
      if (toolName === COLLECTOR_OUTPUT_TOOL) {
        pendingOutputCallId = toolCallId;
        return;
      }
      // Idempotent for the same call across tool_call preflight and execute.
      if (activeOperationalCallId === toolCallId) {
        return;
      }
      if (activeOperationalCallId !== undefined) {
        throw latchFatal("通进司操作调用已在进行");
      }

      if (!isOperationalTool(toolName)) {
        throw latchFatal(`未知通进司工具 ${toolName}`);
      }
      activeOperationalCallId = toolCallId;
    },

    completeOperational(toolCallId) {
      if (pendingOutputCallId === toolCallId) {
        pendingOutputCallId = undefined;
      }
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
      if (cutoff) {
        finalObservationRequired = true;
      }
      const committed = finalizeObservedSnapshot(snapshot);
      appendJournal(COLLECTOR_SNAPSHOT_ENTRY_TYPE, {
        snapshot: committed,
        evidence: committed.evidenceIds.flatMap((id) => {
          const record = evidenceById.get(id);
          return record === undefined ? [] : [record];
        }),
      });

      const modelView = buildObserveModelView({
        snapshot: committed,
        records: committed.evidenceIds.flatMap((id) => {
          const record = evidenceById.get(id);
          return record === undefined ? [] : [record];
        }),
        requesterLogin,
        attempts,
      });

      return {
        snapshot: committed,
        modelView,
        contextView: projectObserveContextView(modelView),
      };
    },

    async request(input, transport, clock, signal) {
      assertNotFatal();
      if (activationTime === undefined || deadlineTime === undefined) {
        throw latchFatal("通进司请求需要激活");
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
        // #676 D6: non-OPEN keeps materials; bounce before cutoff fatal so post-deadline materials still seal.
        throw new CollectorNonOpenRequestError(snapshot.prState);
      }
      if (pastCutoff(clock)) {
        finalObservationRequired = true;
        throw latchFatal("通进司请求不在资格截止前");
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
      commitRequestAttempt(attempt, attemptKey, undefined);
      appendJournal(COLLECTOR_REQUEST_ENTRY_TYPE, {
        attempt: { ...attempt },
        attemptKey,
      });

      const result = await transport.createIssueComment({
        owner: config.repository.owner,
        repo: config.repository.repo,
        prNumber: config.prNumber,
        body,
        ...(signal === undefined ? {} : { signal }),
      });

      const journalRequest = (commentEvidence: CollectorEvidenceRecord | undefined): void => {
        const attemptKey = [
          config.repository.canonical,
          String(config.prNumber),
          attempt.observedHead,
          attempt.requestId,
        ].join("|");
        appendJournal(COLLECTOR_REQUEST_ENTRY_TYPE, {
          attempt: { ...attempt },
          attemptKey,
          commentEvidence,
        });
      };

      if (result.kind === "success") {
        const record = normalizeIssueCommentEvidence(result.comment, startedAt);
        attempt.status = "succeeded";
        attempt.commentEvidenceId = record.evidenceId;
        commitRequestAttempt(attempt, attemptKey, record);
        journalRequest(record);
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
        commitRequestAttempt(attempt, attemptKey, undefined);
        journalRequest(undefined);
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
      commitRequestAttempt(attempt, attemptKey, undefined);
      journalRequest(undefined);
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
      const record: CollectorWaitRecord = {
        waitId,
        requestedMs: input.durationMs,
        effectiveMs,
        startedAt,
        endedAt,
        cutoffReached,
      };
      commitWaitRecord(record);
      appendJournal(COLLECTOR_WAIT_ENTRY_TYPE, {
        waitRecord: record,
      });
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

/**
 * #641 chain①: single authoritative evidence-record projection shared by the
 * observe model view and the pointer-open read tool.
 */
export function projectEvidenceEntryView(record: CollectorEvidenceRecord): ObserveEvidenceEntry {
  return {
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
  };
}

function buildObserveModelView(input: {
  snapshot: CollectorSnapshot;
  records: readonly CollectorEvidenceRecord[];
  requesterLogin: string | undefined;
  attempts: readonly CollectorRequestAttempt[];
}): ObserveModelView {
  const relevant = input.records;
  return {
    snapshotId: input.snapshot.snapshotId,
    observedAt: input.snapshot.observedAt,
    completedAt: input.snapshot.completedAt,
    prState: input.snapshot.prState,
    headOid: input.snapshot.headOid,
    complete: input.snapshot.complete,
    evidence: relevant.map((record): ObserveEvidenceEntry => projectEvidenceEntryView(record)),
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
