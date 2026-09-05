import type {
  GitHubMachineIdentity,
} from "./collector-github.ts";
import type { CollectorEvidenceRecord, HeadRelation } from "./collector-evidence.ts";
import type { CollectorSubmissionProjection } from "./package-contracts/collector-output.ts";
import { CorrectableSubmissionError } from "./submission-correctable-error.ts";

export type { CollectorSubmissionProjection };

export type CollectorMaterialRef = {
  kind: "review" | "issue_comment" | "review_comment" | "reaction";
  id: number;
  /** Receipt-local immutable source reference. */
  evidenceId?: string;
  headRelation?: HeadRelation | "unbound";
};

/**
 * #641 chain①: a receipt finding is a model-classified unit (splitting stays
 * with the collector LLM) whose source pointer resolves against the stored
 * evidence and whose machine locator (repo/PR/comment id/url/author/kind/时间)
 * is enriched by the runtime from the same record — never transcribed bodies.
 */
export type CollectorFinding = {
  identity: GitHubMachineIdentity | null;
  source: CollectorMaterialRef;
  /** Short classification label; not the finding summary. */
  category?: string;
  /** Finding summary for the caller; not a body transcription. */
  summary?: string;
  pointer: {
    repository: string;
    prNumber: number;
    commentId: number;
    htmlUrl?: string;
    authorLogin?: string;
    kind: CollectorMaterialRef["kind"];
    authoritativeTime?: string | null;
    /** Corresponding commit when the evidence carries one. */
    commitOid?: string | null;
  };
};

export type CollectorIdentityGroup = {
  identity: GitHubMachineIdentity | null;
  /** Human-readable metadata only; never participates in grouping. */
  displayLogin?: string;
  attendance?: true;
  findings?: CollectorFinding[];
  materials: CollectorMaterialRef[];
};

export type ExtractedCollectorIdentityGroup = CollectorIdentityGroup & {
  attendance: true;
  findings: CollectorFinding[];
};

function identityKey(identity: GitHubMachineIdentity | null): string {
  if (identity === null) return "unassigned";
  // GitHub omits App metadata on some surfaces (notably review comments).
  // The stable user ID is the grouping identity; richer observed structure is
  // merged below and must not split one actor across transport surfaces.
  return String(identity.userId);
}

function mergeMachineIdentity(
  current: GitHubMachineIdentity | null,
  observed: GitHubMachineIdentity | null,
): GitHubMachineIdentity | null {
  if (current === null) return observed;
  if (observed === null) return current;
  if (current.appId === undefined && observed.appId !== undefined) return observed;
  if (current.appId !== undefined && observed.appId === undefined) return current;
  return observed.userType < current.userType ? observed : current;
}

function headRelationFor(record: CollectorEvidenceRecord, targetHead: string): HeadRelation | "unbound" {
  return record.commitOid === undefined || record.commitOid === null
    ? "unbound"
    : record.commitOid === targetHead ? "current" : "prior";
}

/** Receipt adapter consuming the typed facts retained by transport normalization. */
export function extractCollectorEvidenceIdentityGroups(
  records: readonly CollectorEvidenceRecord[],
  targetHead: string,
): ExtractedCollectorIdentityGroup[] {
  const groups = new Map<string, ExtractedCollectorIdentityGroup>();
  for (const record of records) {
    if (record.kind !== "review" && record.kind !== "issue_comment" && record.kind !== "review_comment" && record.kind !== "reaction") continue;
    if (record.githubId === undefined) continue;
    const identity = record.machineIdentity ?? null;
    const kind = record.kind;
    const source: CollectorMaterialRef = {
      kind,
      id: record.githubId,
      evidenceId: record.evidenceId,
      headRelation: headRelationFor(record, targetHead),
    };
    const key = identityKey(identity);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        identity,
        ...(record.authorLogin === undefined ? {} : { displayLogin: record.authorLogin }),
        attendance: true,
        findings: [],
        materials: [],
      };
      groups.set(key, group);
    } else {
      group.identity = mergeMachineIdentity(group.identity, identity);
    }
    group.materials.push(source);
  }
  return [...groups.values()];
}

/**
 * #641 chain①: pointer-open failures are model misuse, not host failures. The
 * seat rejects them as correctable so the model can retry with a stored
 * evidenceId — on Pi and Grok/ACP alike (第 0 条: 模型提交方式可纠正).
 */
export class CollectorUnknownEvidenceError extends CorrectableSubmissionError {
  constructor(evidenceId: string) {
    super(`未在本局已观测材料中找到 evidenceId ${evidenceId}；请用 observe 返回的指针重试。`);
    this.name = "CollectorUnknownEvidenceError";
  }
}

/**
 * Evidence-binding failure for a finding pointer that resolves to the wrong kind
 * of stored record, lacks a GitHub locator, or has no identity group — not a
 * free-shape gate on the submission envelope.
 */
export class CollectorFindingsValidationError extends CorrectableSubmissionError {
  constructor(message: string) {
    super(message);
    this.name = "CollectorFindingsValidationError";
  }
}

/**
 * #676 D6: non-OPEN targets keep collected materials and must not fire new review
 * requests. Bounce the request as correctable so the seat can still seal output.
 */
export class CollectorNonOpenRequestError extends CorrectableSubmissionError {
  constructor(prState: string) {
    super(`通进司请求要求 OPEN 状态的 PR 快照；当前为 ${prState}，不再触发新评审，请直接交回已有材料`);
    this.name = "CollectorNonOpenRequestError";
  }
}

function candidateRecord(candidate: unknown): Record<string, unknown> | undefined {
  if (candidate === undefined || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate as Record<string, unknown>;
}

/** Canonical top-level keys the collector output projection understands. */
const COLLECTOR_OUTPUT_CANONICAL_KEYS = new Set([
  "findings",
  "unfinishedReasons",
  "infrastructureFailure",
]);

/** Non-canonical own keys mean content was present but not under a projectable key. */
function hasNonCanonicalOwnKeys(record: Record<string, unknown>): boolean {
  for (const key of Object.keys(record)) {
    if (!COLLECTOR_OUTPUT_CANONICAL_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * #641 chain① / #676: turn model-submitted finding pointer refs into receipt findings.
 * Binds resolvable evidence references only — no pure shape rejection of the
 * candidate envelope. Unknown refs, wrong kinds, missing GitHub locator, and
 * missing identity group stay as binding failures. Unreadable findings content
 * is not washed into "zero findings": projection facts record the gap so
 * downstream can open the session 正本 (第 0 条 / #676 C).
 */
export function enrichCollectorFindings(input: {
  candidate: unknown;
  records: readonly CollectorEvidenceRecord[];
  groups: readonly ExtractedCollectorIdentityGroup[];
  targetHead: string;
  repository: string;
  prNumber: number;
}): {
  findingsSource: CollectorSubmissionProjection["findingsSource"];
  findingsProjectedCount: number;
  findingsUnprojected: boolean;
} {
  // Candidate present but not a record — content existed, none projected (#676 C).
  if (input.candidate !== undefined && input.candidate !== null && candidateRecord(input.candidate) === undefined) {
    return { findingsSource: "unreadable", findingsProjectedCount: 0, findingsUnprojected: true };
  }
  const record = candidateRecord(input.candidate);
  if (record === undefined) {
    return { findingsSource: "absent", findingsProjectedCount: 0, findingsUnprojected: false };
  }
  if (!Object.hasOwn(record, "findings")) {
    // Non-canonical top-level content is not "absent" — record the projection gap (#676 C).
    if (hasNonCanonicalOwnKeys(record)) {
      return { findingsSource: "unreadable", findingsProjectedCount: 0, findingsUnprojected: true };
    }
    return { findingsSource: "absent", findingsProjectedCount: 0, findingsUnprojected: false };
  }
  const rawFindings = record["findings"];
  if (!Array.isArray(rawFindings)) {
    // Key present but not an array — content exists, none projected. No shape bounce.
    return { findingsSource: "unreadable", findingsProjectedCount: 0, findingsUnprojected: true };
  }

  const byEvidenceId = new Map(input.records.map((evidence) => [evidence.evidenceId, evidence]));
  let projected = 0;
  let unprojected = false;
  for (const raw of rawFindings) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      unprojected = true;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const evidenceId = item.evidenceId;
    if (typeof evidenceId !== "string" || evidenceId.length === 0) {
      // Present item without a bindable pointer — keep gap fact, do not fabricate.
      unprojected = true;
      continue;
    }
    const evidence = byEvidenceId.get(evidenceId);
    if (evidence === undefined) {
      throw new CollectorUnknownEvidenceError(evidenceId);
    }
    if (evidence.kind !== "review" && evidence.kind !== "issue_comment" && evidence.kind !== "review_comment") {
      throw new CollectorFindingsValidationError(`通进司 finding 指针指向不可承 finding 的证据种类 ${evidence.kind}`);
    }
    if (evidence.githubId === undefined) {
      throw new CollectorFindingsValidationError(`通进司 finding 指针证据 ${evidenceId} 缺少 GitHub id`);
    }
    const identity = evidence.machineIdentity ?? null;
    const group = input.groups.find((candidateGroup) => identityKey(candidateGroup.identity) === identityKey(identity));
    if (group === undefined) {
      throw new CollectorFindingsValidationError(`通进司 finding 指针证据 ${evidenceId} 无归属身份组`);
    }
    // Bound finding keeps pointer; non-string category/summary are unprojected field gaps
    // (pointer success ≠ full content projection) — #676 C / 3939511832.
    const category = item.category;
    const summary = item.summary;
    if (Object.hasOwn(item, "category") && typeof category !== "string") unprojected = true;
    if (Object.hasOwn(item, "summary") && typeof summary !== "string") unprojected = true;
    group.findings.push({
      identity,
      source: {
        kind: evidence.kind,
        id: evidence.githubId,
        evidenceId: evidence.evidenceId,
        headRelation: headRelationFor(evidence, input.targetHead),
      },
      ...(typeof category === "string" ? { category } : {}),
      ...(typeof summary === "string" ? { summary } : {}),
      pointer: {
        repository: input.repository,
        prNumber: input.prNumber,
        commentId: evidence.githubId,
        ...(evidence.htmlUrl === undefined ? {} : { htmlUrl: evidence.htmlUrl }),
        ...(evidence.authorLogin === undefined ? {} : { authorLogin: evidence.authorLogin }),
        kind: evidence.kind,
        authoritativeTime: evidence.authoritativeTime ?? null,
        ...(evidence.commitOid === undefined ? {} : { commitOid: evidence.commitOid }),
      },
    });
    projected += 1;
  }
  return {
    findingsSource: "array",
    findingsProjectedCount: projected,
    findingsUnprojected: unprojected,
  };
}

/**
 * #676 D6/C: optional unfinished reasons from the model submission.
 * Project readable strings; record when original content could not fully project
 * (do not wash unreadable unfinishedReasons into "none").
 */
export function extractCollectorUnfinishedReasons(candidate: unknown): {
  reasons: string[] | undefined;
  source: CollectorSubmissionProjection["unfinishedReasonsSource"];
  unprojected: boolean;
} {
  if (candidate !== undefined && candidate !== null && candidateRecord(candidate) === undefined) {
    return { reasons: undefined, source: "unreadable", unprojected: true };
  }
  const record = candidateRecord(candidate);
  if (record === undefined) {
    return { reasons: undefined, source: "absent", unprojected: false };
  }
  if (!Object.hasOwn(record, "unfinishedReasons")) {
    // unfinishedReasons absent is fine when only findings (or nothing) present.
    // Non-canonical keys alone are recorded on the findings projection path.
    return { reasons: undefined, source: "absent", unprojected: false };
  }
  const raw = record["unfinishedReasons"];
  if (!Array.isArray(raw)) {
    return { reasons: undefined, source: "unreadable", unprojected: true };
  }
  const reasons = raw.filter((item): item is string => typeof item === "string");
  const unprojected = reasons.length !== raw.length;
  return {
    reasons: reasons.length > 0 ? reasons : undefined,
    source: "array",
    unprojected,
  };
}
