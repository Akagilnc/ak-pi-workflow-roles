import Value from "typebox/value";

import type { CollectorManifest, CollectorRepository } from "./collector-config.ts";
import {
  applyEvidenceVersionHistory,
  assertCollectorByteLimit,
  assignWindowRelations,
  COLLECTOR_ELIGIBILITY_MS,
  COLLECTOR_RECEIPT_MAX_BYTES,
  COLLECTOR_SNAPSHOT_MAX_BYTES,
  createSnapshotByteBudget,
  measureNormalizedBytes,
  normalizeAuthenticatedUserEvidence,
  normalizeIssueCommentEvidence,
  normalizePullRequestEvidence,
  normalizeReviewCommentEvidence,
  normalizeReviewEvidence,
  reviewQualifiesForValid,
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

/** Raw finalized tool-call candidate, including malformed id/name/arguments. */
export type CollectorRawToolCallPart = {
  type: "toolCall";
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

export type CollectorToolCallPart = {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
};

export type PermittedBatch =
  | { kind: "operational"; callId: string; name: CollectorOperationalTool }
  | { kind: "output"; callId: string; name: typeof COLLECTOR_OUTPUT_TOOL };

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
  readonly mutationGeneration: number;
  readonly observedGeneration: number;
  readonly permittedBatch: PermittedBatch | undefined;

  latchFatal(reason: string): Error;
  assertNotFatal(): void;
  recordActivation(clock: CollectorClock): void;
  evaluateBatch(
    calls: readonly CollectorRawToolCallPart[],
  ): { allow: true; permitted: PermittedBatch } | { allow: false; reason: string };
  beginOperational(toolName: string, toolCallId: string): void;
  completeOperational(toolCallId: string): void;
  markOutputAccepted(): void;
  noteCutoffObserved(): void;
  assertOutputObservationLaw(
    candidate: { legs: ReadonlyArray<{ status: string }> },
    clock: CollectorClock,
  ): void;

  observe(
    transport: CollectorGitHubTransport,
    clock: CollectorClock,
    signal?: AbortSignal,
  ): Promise<{
    snapshot: CollectorSnapshot;
    modelView: unknown;
  }>;

  request(
    input: { legId: string; snapshotId: string },
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validate Collector tool argument shapes at batch-classification time. */
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

type ClassifiedCall =
  | { kind: "malformed"; reason: string }
  | { kind: "illegal"; reason: string; id?: string; name?: string }
  | {
    kind: "operational";
    callId: string;
    name: CollectorOperationalTool;
  }
  | { kind: "output"; callId: string };

export function classifyRawToolCall(part: CollectorRawToolCallPart): ClassifiedCall {
  if (part.type !== "toolCall") {
    return { kind: "malformed", reason: "content part is not a toolCall" };
  }
  if (!nonEmptyString(part.id) || !nonEmptyString(part.name)) {
    return {
      kind: "malformed",
      reason: "toolCall missing string id or name",
    };
  }
  const callId = part.id;
  const name = part.name;
  if (!isCollectorTool(name)) {
    return {
      kind: "illegal",
      reason: `non-Collector sibling tool ${name}`,
      id: callId,
      name,
    };
  }
  if (!collectorToolArgumentsValid(name, part.arguments)) {
    return {
      kind: "illegal",
      reason: `schema-invalid arguments for ${name}`,
      id: callId,
      name,
    };
  }
  if (name === COLLECTOR_OUTPUT_TOOL) {
    return { kind: "output", callId };
  }
  return {
    kind: "operational",
    callId,
    name: name as CollectorOperationalTool,
  };
}

/**
 * Authoritative finalized-message batch classifier.
 * Walks every raw toolCall candidate; malformed/unknown/schema-invalid poison the batch.
 */
export function classifyCollectorBatch(
  calls: readonly CollectorRawToolCallPart[],
  options: {
    outputAccepted: boolean;
    hasCompletedOperationalOrSnapshot: boolean;
  },
):
  | { allow: true; permitted: PermittedBatch }
  | { allow: false; reason: string } {
  if (calls.length === 0) {
    return {
      allow: false,
      reason: "Collector batch contains no toolCall parts",
    };
  }

  const classified = calls.map((call) => classifyRawToolCall(call));
  for (const item of classified) {
    if (item.kind === "malformed") {
      return {
        allow: false,
        reason: `Collector batch poisoned by malformed toolCall: ${item.reason}`,
      };
    }
    if (item.kind === "illegal") {
      return {
        allow: false,
        reason: `Collector batch illegal: ${item.reason}`,
      };
    }
  }

  const operational = classified.filter(
    (item): item is Extract<ClassifiedCall, { kind: "operational" }> =>
      item.kind === "operational",
  );
  const outputs = classified.filter(
    (item): item is Extract<ClassifiedCall, { kind: "output" }> =>
      item.kind === "output",
  );

  if (operational.length === 1 && outputs.length === 0 && classified.length === 1) {
    const only = operational[0]!;
    return {
      allow: true,
      permitted: {
        kind: "operational",
        callId: only.callId,
        name: only.name,
      },
    };
  }

  if (outputs.length === 1 && operational.length === 0 && classified.length === 1) {
    if (options.outputAccepted) {
      return {
        allow: false,
        reason: "Collector output already accepted; second output is illegal",
      };
    }
    if (!options.hasCompletedOperationalOrSnapshot) {
      return {
        allow: false,
        reason:
          "Collector output requires a prior completed operational result in this invocation",
      };
    }
    const only = outputs[0]!;
    return {
      allow: true,
      permitted: {
        kind: "output",
        callId: only.callId,
        name: COLLECTOR_OUTPUT_TOOL,
      },
    };
  }

  return {
    allow: false,
    reason:
      "Collector permits exactly one schema-valid operational call (observe|request|wait) per assistant batch, or a sole later schema-valid output call",
  };
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
  let permittedBatch: PermittedBatch | undefined;
  let operationalCompletedSinceOutputPermit = false;
  let mutationGeneration = 0;
  let observedGeneration = 0;

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
    permittedBatch = undefined;
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
    try {
      assertCollectorByteLimit(label, bytes, COLLECTOR_RECEIPT_MAX_BYTES);
    } catch (error) {
      throw latchFatal(error instanceof Error ? error.message : String(error));
    }
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
    // One observation-attempt budget; resets on PR-identity retry.
    const budget = createSnapshotByteBudget(COLLECTOR_SNAPSHOT_MAX_BYTES);
    const user = await transport.getAuthenticatedUser(signalOpt);
    budget.retain([normalizeAuthenticatedUserEvidence(user, observedAt)]);
    const prInitial = await transport.getPullRequest({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    budget.retain([normalizePullRequestEvidence(prInitial, observedAt)]);
    const reviews = await transport.listPullRequestReviews({
      owner,
      repo,
      prNumber,
      ...signalOpt,
      retainPage: (items) => {
        budget.retain(
          items.map((item) => normalizeReviewEvidence(item, observedAt)),
        );
      },
    });
    const issueComments = await transport.listIssueComments({
      owner,
      repo,
      prNumber,
      ...signalOpt,
      retainPage: (items) => {
        budget.retain(
          items.map((item) => normalizeIssueCommentEvidence(item, observedAt)),
        );
      },
    });
    const reviewComments = await transport.listReviewComments({
      owner,
      repo,
      prNumber,
      ...signalOpt,
      retainPage: (items) => {
        budget.retain(
          items.map((item) => normalizeReviewCommentEvidence(item, observedAt)),
        );
      },
    });
    const prTerminal = await transport.getPullRequest({
      owner,
      repo,
      prNumber,
      ...signalOpt,
    });
    return { user, prInitial, reviews, issueComments, reviewComments, prTerminal };
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
    get permittedBatch() {
      return permittedBatch;
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
      if (fatal) {
        return {
          allow: false,
          reason: fatalReason ?? "Collector is in fatal state",
        };
      }
      const decision = classifyCollectorBatch(calls, {
        outputAccepted,
        hasCompletedOperationalOrSnapshot:
          operationalCompletedSinceOutputPermit || snapshots.length > 0,
      });
      if (!decision.allow) {
        latchFatal(decision.reason);
        return decision;
      }
      permittedBatch = decision.permitted;
      return decision;
    },

    beginOperational(toolName, toolCallId) {
      assertNotFatal();
      if (permittedBatch === undefined) {
        throw latchFatal(
          "Collector rejected tool execution without a permitted assistant batch",
        );
      }
      if (outputAccepted && toolName !== COLLECTOR_OUTPUT_TOOL) {
        throw latchFatal("Collector output already accepted; no further operations");
      }
      // Idempotent for the same call across tool_call preflight and execute.
      if (activeOperationalCallId === toolCallId) {
        return;
      }
      if (activeOperationalCallId !== undefined && activeOperationalCallId !== toolCallId) {
        throw latchFatal("Collector operational call already active");
      }

      if (toolName === COLLECTOR_OUTPUT_TOOL) {
        if (
          permittedBatch.kind !== "output" ||
          permittedBatch.callId !== toolCallId
        ) {
          throw latchFatal(
            "Collector output call does not match the permitted batch",
          );
        }
        return;
      }

      if (!isOperationalTool(toolName)) {
        throw latchFatal(`Unknown Collector tool ${toolName}`);
      }
      if (
        permittedBatch.kind !== "operational" ||
        permittedBatch.callId !== toolCallId ||
        permittedBatch.name !== toolName
      ) {
        throw latchFatal(
          "Collector operational call does not match the permitted batch",
        );
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

    assertOutputObservationLaw(candidate, clock) {
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
      const hasMissing = candidate.legs.some((leg) => leg.status === "missing");

      if (!atOrAfterCutoff && hasMissing) {
        throw new Error(
          "Collector missing status is forbidden before the eligibility cutoff",
        );
      }

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
        throw latchFatal(
          `Collector observe failed: ${
            signal.reason instanceof Error
              ? signal.reason.message
              : String(signal.reason ?? "aborted")
          }`,
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
        const message = error instanceof Error ? error.message : String(error);
        throw latchFatal(`Collector observe failed: ${message}`);
      }

      // First-sighting trust must not predate actual surface observation.
      // Observe-start may be before cutoff while surfaces arrive after; stamp
      // evidence wall metadata and mono trust only once surfaces are in hand
      // (budget retain during fetch may keep the temporary start stamp).
      const firstObservedAt = clock.wallNow().toISOString(); // metadata
      const firstObservedMono = monoNowOrThrow(clock); // trust

      // Always bind terminal PR identity fields.
      const pr = surfaces.prTerminal;
      const { user, reviews, issueComments, reviewComments } = surfaces;

      requesterLogin = user.login.toLowerCase();

      const pageDiagnostics: GitHubPageDiagnostics[] = [
        ...reviews.pages,
        ...issueComments.pages,
        ...reviewComments.pages,
      ];

      const pendingRecords: CollectorEvidenceRecord[] = [];
      pendingRecords.push(normalizeAuthenticatedUserEvidence(user, firstObservedAt));
      pendingRecords.push(normalizePullRequestEvidence(pr, firstObservedAt));
      for (const review of reviews.items) {
        pendingRecords.push(normalizeReviewEvidence(review, firstObservedAt));
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
      try {
        assertCollectorByteLimit(
          "snapshot",
          normalizedByteLength,
          COLLECTOR_SNAPSHOT_MAX_BYTES,
        );
      } catch (error) {
        throw latchFatal(error instanceof Error ? error.message : String(error));
      }

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
        if (failure.marker === undefined || failure.legId === undefined) continue;
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
            item.legId === failure.legId &&
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
      assertMaterializationWithinBound("invocation ledger");

      const modelView = buildObserveModelView({
        snapshot,
        records: storedRecords,
        configuredAuthors,
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

      // Existing exact-head qualifying review means no request (same law as receipt valid).
      const expected = new Set(leg.expectedAuthors);
      const hasQualifying = snapshot.evidenceIds.some((id) => {
        const record = evidenceById.get(id);
        if (record === undefined || record.kind !== "review") return false;
        return reviewQualifiesForValid({
          review: record,
          expectedAuthors: expected,
          targetHead: snapshot.headOid,
          activationTime: activationTime!,
          deadlineTime: deadlineTime!,
        }).ok;
      });
      if (hasQualifying) {
        throw new Error(
          `Collector leg \"${input.legId}\" already has an exact-head qualifying review; request refused`,
        );
      }

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
      legId: attempt.legId,
      observedHead: attempt.observedHead,
      status: attempt.status,
      marker: attempt.marker,
      recoverySnapshotId: attempt.recoverySnapshotId,
    })),
  };
}
