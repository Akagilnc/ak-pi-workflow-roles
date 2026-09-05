/** Package-owned Collector receipt leaf — no role registration surface. */

export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";
export const COLLECTOR_ACCEPTED_TEXT = "通进司回执已接受";
export const COLLECTOR_HOST = "github.com";

export type CollectorIdentityGroup = {
  identity: Record<string, unknown> | null;
  displayLogin?: string;
  attendance: true;
  materials: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
};

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
  recoverySnapshotId?: string;
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
  pageDiagnostics: Array<Record<string, unknown>>;
  normalizedByteLength: number;
};

/**
 * #641 chain① receipt evidence record: pointer/integrity facts only. Bodies and
 * raw payloads stay in the volume (observe details + GitHub pointer) and are
 * never transcribed into the receipt.
 */
export type CollectorEvidenceRecord = {
  evidenceId: string;
  kind: string;
  versionId: string;
  contentDigest: string;
  firstObservedAt: string;
  githubId?: number;
  authorLogin?: string;
  htmlUrl?: string;
  authoritativeTime?: string | null;
};

/**
 * #676 C: sole structured projection-fact type (builder + package leaf).
 * Builder always emits the full object; package leaf keeps it optional so old
 * volumes without the field stay readable — missing is unknown, never defaulted.
 */
export type CollectorSubmissionProjection = {
  findingsSource: "absent" | "array" | "unreadable";
  findingsProjectedCount: number;
  findingsUnprojected: boolean;
  unfinishedReasonsSource: "absent" | "array" | "unreadable";
  unfinishedReasonsProjectedCount: number;
  unfinishedReasonsUnprojected: boolean;
};

export type CollectorReceipt = {
  host: "github.com";
  repository: string;
  prNumber: number;
  /**
   * Final observed PR state; non-OPEN still delivers materials (#676 D6).
   * Absent/unreadable on old volumes is unknown — never defaulted to OPEN.
   */
  prState?: string;
  manifestDigest: string;
  activationTime: string;
  deadlineTime: string;
  finalObservationTime: string;
  finalSnapshotId: string;
  targetHead: string;
  groups: CollectorIdentityGroup[];
  unfinishedReasons?: string[];
  /**
   * Distinguishes readable-empty from unprojected original submission content (#676 C).
   * Package leaf may carry a partial projection when some sibling keys are unreadable —
   * missing keys stay absent (never defaulted false/0/OPEN).
   */
  submissionProjection?: Partial<CollectorSubmissionProjection>;
  requestAttempts: CollectorRequestAttempt[];
  snapshots: CollectorSnapshot[];
  evidenceRecords: CollectorEvidenceRecord[];
};

function safeGet(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Settlement projection. Presence of the canonical groups array is the one Collector terminal discriminator. */
export function validateAcceptedCollectorReceipt(value: unknown): CollectorReceipt {
  const rawGroups = safeGet(value, "groups");
  if (!Array.isArray(rawGroups)) throw new Error("Collector receipt has no typed groups terminal discriminator");
  const groups = records(rawGroups).map((group) => ({
    identity: (safeGet(group, "identity") ?? null) as Record<string, unknown> | null,
    ...(typeof safeGet(group, "displayLogin") === "string" ? { displayLogin: safeGet(group, "displayLogin") as string } : {}),
    attendance: true as const,
    materials: records(safeGet(group, "materials")),
    findings: records(safeGet(group, "findings")),
  }));
  const unfinishedRaw = safeGet(value, "unfinishedReasons");
  const unfinishedReasons = strings(unfinishedRaw);
  // #676 C: project readable submissionProjection fields independently — do not
  // drop the whole block when one sibling key is the wrong type (left-拾遗1).
  const submissionProjection = projectSubmissionProjection(safeGet(value, "submissionProjection"));
  const prStateRaw = safeGet(value, "prState");
  const prState = typeof prStateRaw === "string" ? prStateRaw : undefined;
  return {
    host: safeGet(value, "host") as "github.com",
    repository: safeGet(value, "repository") as string,
    prNumber: safeGet(value, "prNumber") as number,
    ...(prState === undefined ? {} : { prState }),
    manifestDigest: safeGet(value, "manifestDigest") as string,
    activationTime: safeGet(value, "activationTime") as string,
    deadlineTime: safeGet(value, "deadlineTime") as string,
    finalObservationTime: safeGet(value, "finalObservationTime") as string,
    finalSnapshotId: safeGet(value, "finalSnapshotId") as string,
    targetHead: safeGet(value, "targetHead") as string,
    groups,
    ...(unfinishedReasons.length > 0 ? { unfinishedReasons } : {}),
    ...(submissionProjection === undefined ? {} : { submissionProjection }),
    requestAttempts: records(safeGet(value, "requestAttempts")) as unknown as CollectorRequestAttempt[],
    snapshots: records(safeGet(value, "snapshots")).map((snapshot) => ({
      snapshotId: safeGet(snapshot, "snapshotId"), observedAt: safeGet(snapshot, "observedAt"), completedAt: safeGet(snapshot, "completedAt"), completedMono: safeGet(snapshot, "completedMono"), host: safeGet(snapshot, "host"), repository: safeGet(snapshot, "repository"), prNumber: safeGet(snapshot, "prNumber"), prState: safeGet(snapshot, "prState"), headOid: safeGet(snapshot, "headOid"), complete: safeGet(snapshot, "complete"), evidenceIds: strings(safeGet(snapshot, "evidenceIds")), pageDiagnostics: records(safeGet(snapshot, "pageDiagnostics")), normalizedByteLength: safeGet(snapshot, "normalizedByteLength"),
    } as CollectorSnapshot)),
    evidenceRecords: records(safeGet(value, "evidenceRecords")).map((record) => ({ evidenceId: safeGet(record, "evidenceId"), kind: safeGet(record, "kind"), versionId: safeGet(record, "versionId"), contentDigest: safeGet(record, "contentDigest"), firstObservedAt: safeGet(record, "firstObservedAt"), githubId: safeGet(record, "githubId"), authorLogin: safeGet(record, "authorLogin"), htmlUrl: safeGet(record, "htmlUrl"), authoritativeTime: safeGet(record, "authoritativeTime") } as CollectorEvidenceRecord)),
  };
}

/** Readable projection facts only; omit keys that are the wrong type — never fabricate defaults. */
function projectSubmissionProjection(
  raw: unknown,
): Partial<CollectorSubmissionProjection> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const out: Partial<CollectorSubmissionProjection> = {};
  if (
    p["findingsSource"] === "absent" ||
    p["findingsSource"] === "array" ||
    p["findingsSource"] === "unreadable"
  ) {
    out.findingsSource = p["findingsSource"];
  }
  if (typeof p["findingsProjectedCount"] === "number") {
    out.findingsProjectedCount = p["findingsProjectedCount"];
  }
  if (typeof p["findingsUnprojected"] === "boolean") {
    out.findingsUnprojected = p["findingsUnprojected"];
  }
  if (
    p["unfinishedReasonsSource"] === "absent" ||
    p["unfinishedReasonsSource"] === "array" ||
    p["unfinishedReasonsSource"] === "unreadable"
  ) {
    out.unfinishedReasonsSource = p["unfinishedReasonsSource"];
  }
  if (typeof p["unfinishedReasonsProjectedCount"] === "number") {
    out.unfinishedReasonsProjectedCount = p["unfinishedReasonsProjectedCount"];
  }
  if (typeof p["unfinishedReasonsUnprojected"] === "boolean") {
    out.unfinishedReasonsUnprojected = p["unfinishedReasonsUnprojected"];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
