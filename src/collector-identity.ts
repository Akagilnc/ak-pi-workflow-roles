import type {
  GitHubMachineIdentity,
} from "./collector-github.ts";
import type { CollectorEvidenceRecord, HeadRelation } from "./collector-evidence.ts";
import { CorrectableSubmissionError } from "./submission-correctable-error.ts";

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
  category?: string;
  pointer: {
    repository: string;
    prNumber: number;
    commentId: number;
    htmlUrl?: string;
    authorLogin?: string;
    kind: CollectorMaterialRef["kind"];
    authoritativeTime?: string | null;
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
 * #641 chain①: any malformed findings submission is a model misuse the model
 * can correct and resubmit — a branded correctable rejection on every supported
 * engine, never a round infrastructure failure.
 */
export class CollectorFindingsValidationError extends CorrectableSubmissionError {
  constructor(message: string) {
    super(message);
    this.name = "CollectorFindingsValidationError";
  }
}

/**
 * #641 chain①: turn model-submitted finding pointer refs into receipt findings.
 * Each pointer must resolve to a stored text-bearing evidence record; the
 * machine locator is enriched from the same record so receipt and volume agree
 * (指针可解析、开卷相符) by construction. Throws branded correctable
 * (non-fatal, model-visible) errors for unresolvable or mis-typed findings.
 */
export function enrichCollectorFindings(input: {
  candidate: unknown;
  records: readonly CollectorEvidenceRecord[];
  groups: readonly ExtractedCollectorIdentityGroup[];
  targetHead: string;
  repository: string;
  prNumber: number;
}): void {
  const candidate = input.candidate;
  if (candidate === undefined || candidate === null) return;
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new CollectorFindingsValidationError("通进司交件参数必须为对象");
  }
  const rawFindings = (candidate as { findings?: unknown }).findings;
  if (rawFindings === undefined) return;
  if (!Array.isArray(rawFindings)) {
    throw new CollectorFindingsValidationError("通进司 findings 必须为数组");
  }
  const byEvidenceId = new Map(input.records.map((record) => [record.evidenceId, record]));
  for (const raw of rawFindings) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CollectorFindingsValidationError("通进司 finding 必须为对象");
    }
    const evidenceId = (raw as { evidenceId?: unknown }).evidenceId;
    if (typeof evidenceId !== "string" || evidenceId.length === 0) {
      throw new CollectorFindingsValidationError("通进司 finding 缺少可解析的 evidenceId 指针");
    }
    const record = byEvidenceId.get(evidenceId);
    if (record === undefined) {
      throw new CollectorUnknownEvidenceError(evidenceId);
    }
    if (record.kind !== "review" && record.kind !== "issue_comment" && record.kind !== "review_comment") {
      throw new CollectorFindingsValidationError(`通进司 finding 指针指向不可承 finding 的证据种类 ${record.kind}`);
    }
    if (record.githubId === undefined) {
      throw new CollectorFindingsValidationError(`通进司 finding 指针证据 ${evidenceId} 缺少 GitHub id`);
    }
    const category = (raw as { category?: unknown }).category;
    if (category !== undefined && (typeof category !== "string" || category.trim().length === 0)) {
      throw new CollectorFindingsValidationError("通进司 finding category 必须为非空字符串");
    }
    const identity = record.machineIdentity ?? null;
    const group = input.groups.find((candidateGroup) => identityKey(candidateGroup.identity) === identityKey(identity));
    if (group === undefined) {
      throw new CollectorFindingsValidationError(`通进司 finding 指针证据 ${evidenceId} 无归属身份组`);
    }
    group.findings.push({
      identity,
      source: {
        kind: record.kind,
        id: record.githubId,
        evidenceId: record.evidenceId,
        headRelation: headRelationFor(record, input.targetHead),
      },
      ...(category === undefined ? {} : { category: category.trim() }),
      pointer: {
        repository: input.repository,
        prNumber: input.prNumber,
        commentId: record.githubId,
        ...(record.htmlUrl === undefined ? {} : { htmlUrl: record.htmlUrl }),
        ...(record.authorLogin === undefined ? {} : { authorLogin: record.authorLogin }),
        kind: record.kind,
        authoritativeTime: record.authoritativeTime ?? null,
      },
    });
  }
}
