/** Package-owned Collector receipt leaf — no role registration surface. */

export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";
export const COLLECTOR_ACCEPTED_TEXT = "Collector receipt accepted";
export const COLLECTOR_HOST = "github.com";

export type CollectorLegStatus = "valid" | "unavailable" | "missing";

export type ReviewDerivedReport = {
  kind: "review";
  legId: string;
  report: string;
  reviewedHead: string;
  headRelation: string;
  windowRelation: string;
  evidenceRefs: string[];
};

export type TerminalFactReport = {
  kind: "terminal-fact";
  legId: string;
  terminalStatus: "unavailable" | "missing";
  report: string;
  windowRelation: string;
  evidenceRefs: string[];
  targetSnapshotHead?: string;
  scope?: "global";
};

export type CollectorReport = ReviewDerivedReport | TerminalFactReport;

export type CollectorReceiptLeg = {
  legId: string;
  status: CollectorLegStatus;
  rationale: string;
  evidenceRefs: string[];
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
  recoverySnapshotId?: string;
};

export type CollectorPageDiagnostics = {
  path: string;
  page: number;
  status: number;
  itemCount: number;
  linkHeader?: string;
};

export type CollectorSnapshot = {
  snapshotId: string;
  observedAt: string;
  completedAt: string;
  completedMono: number;
  host: "github.com";
  repository: string;
  prNumber: number;
  prState: string;
  headOid: string;
  complete: boolean;
  evidenceIds: string[];
  pageDiagnostics: CollectorPageDiagnostics[];
  normalizedByteLength: number;
};

export type CollectorEvidenceRecord = {
  evidenceId: string;
  kind: string;
  versionId: string;
  contentDigest: string;
  firstObservedAt: string;
  raw: unknown;
  stableGitHubId?: string;
  authorLogin?: string;
  state?: string;
  body?: string;
  commitOid?: string | null;
  htmlUrl?: string;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  side?: string | null;
  position?: number | null;
  pullRequestReviewId?: number | null;
  submittedAt?: string | null;
  authoritativeTime?: string | null;
  windowRelation?: string;
  pagination?: {
    surface: string;
    complete: boolean;
    pages: CollectorPageDiagnostics[];
  };
};

export type CollectorIdentityGroup = {
  identity: Record<string, unknown> | null;
  displayLogin?: string;
  attendance: true;
  degraded: boolean;
  materials: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
};

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
  /** Canonical machine-identity attendance groups. */
  groups?: CollectorIdentityGroup[];
  /** Legacy read-only view derived from groups; removed after consumer migration. */
  identityGroups?: CollectorIdentityGroup[];
  reports: CollectorReport[];
  legs: CollectorReceiptLeg[];
  requestAttempts: CollectorRequestAttempt[];
  snapshots: CollectorSnapshot[];
  evidenceRecords: CollectorEvidenceRecord[];
};

export type CollectorGeneratedOutput = {
  legs: Array<{
    legId: string;
    status: CollectorLegStatus;
    rationale: string;
    evidenceRefs: string[];
    unavailableScope?: "target" | "global";
  }>;
};

function safeGet(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object"
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function projectReport(value: Record<string, unknown>): CollectorReport {
  const common = {
    legId: safeGet(value, "legId") as string,
    report: safeGet(value, "report") as string,
    windowRelation: safeGet(value, "windowRelation") as string,
    evidenceRefs: strings(safeGet(value, "evidenceRefs")),
  };
  if (safeGet(value, "kind") === "review") {
    return {
      kind: "review",
      ...common,
      reviewedHead: safeGet(value, "reviewedHead") as string,
      headRelation: safeGet(value, "headRelation") as string,
    };
  }
  const terminal: TerminalFactReport = {
    kind: "terminal-fact",
    ...common,
    terminalStatus: safeGet(value, "terminalStatus") as "unavailable" | "missing",
  };
  const targetSnapshotHead = safeGet(value, "targetSnapshotHead");
  const scope = safeGet(value, "scope");
  if (targetSnapshotHead !== undefined) terminal.targetSnapshotHead = targetSnapshotHead as string;
  if (scope !== undefined) terminal.scope = scope as "global";
  return terminal;
}

/**
 * Safely project the receipt fields consumed by settlement. Runtime ledger
 * construction owns their semantic bindings; this boundary does not impose a
 * second required/type/closed/status shape contract.
 */
export function validateAcceptedCollectorReceipt(value: unknown): CollectorReceipt {
  const snapshots = records(safeGet(value, "snapshots")).map((snapshot) => ({
    snapshotId: safeGet(snapshot, "snapshotId"),
    observedAt: safeGet(snapshot, "observedAt"),
    completedAt: safeGet(snapshot, "completedAt"),
    completedMono: safeGet(snapshot, "completedMono"),
    host: safeGet(snapshot, "host"),
    repository: safeGet(snapshot, "repository"),
    prNumber: safeGet(snapshot, "prNumber"),
    prState: safeGet(snapshot, "prState"),
    headOid: safeGet(snapshot, "headOid"),
    complete: safeGet(snapshot, "complete"),
    evidenceIds: strings(safeGet(snapshot, "evidenceIds")),
    pageDiagnostics: records(safeGet(snapshot, "pageDiagnostics")),
    normalizedByteLength: safeGet(snapshot, "normalizedByteLength"),
  } as CollectorSnapshot));
  const evidenceRecords = records(safeGet(value, "evidenceRecords")).map((record) => ({
    evidenceId: safeGet(record, "evidenceId"),
    kind: safeGet(record, "kind"),
    versionId: safeGet(record, "versionId"),
    contentDigest: safeGet(record, "contentDigest"),
    firstObservedAt: safeGet(record, "firstObservedAt"),
    raw: safeGet(record, "raw"),
  } as CollectorEvidenceRecord));
  const rawGroups = records(safeGet(value, "groups"));
  const groupSource = rawGroups.length > 0
    ? rawGroups
    : records(safeGet(value, "identityGroups"));
  const groups = groupSource.map((group) => ({
    identity: (safeGet(group, "identity") ?? null) as Record<string, unknown> | null,
    ...(typeof safeGet(group, "displayLogin") === "string"
      ? { displayLogin: safeGet(group, "displayLogin") as string }
      : {}),
    attendance: true as const,
    degraded: safeGet(group, "degraded") === true,
    materials: records(safeGet(group, "materials")),
    findings: records(safeGet(group, "findings")),
  }));
  return {
    host: safeGet(value, "host") as "github.com",
    repository: safeGet(value, "repository") as string,
    prNumber: safeGet(value, "prNumber") as number,
    manifestDigest: safeGet(value, "manifestDigest") as string,
    activationTime: safeGet(value, "activationTime") as string,
    deadlineTime: safeGet(value, "deadlineTime") as string,
    finalObservationTime: safeGet(value, "finalObservationTime") as string,
    finalSnapshotId: safeGet(value, "finalSnapshotId") as string,
    targetHead: safeGet(value, "targetHead") as string,
    groups,
    identityGroups: groups,
    reports: records(safeGet(value, "reports")).map(projectReport),
    legs: records(safeGet(value, "legs")).map((leg) => ({
      legId: safeGet(leg, "legId") as string,
      status: safeGet(leg, "status") as CollectorLegStatus,
      rationale: safeGet(leg, "rationale") as string,
      evidenceRefs: strings(safeGet(leg, "evidenceRefs")),
    })),
    requestAttempts: records(safeGet(value, "requestAttempts")) as unknown as CollectorRequestAttempt[],
    snapshots,
    evidenceRecords,
  };
}
