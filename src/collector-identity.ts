import {
  type GitHubIssueComment,
  type GitHubMachineIdentity,
  type GitHubPullRequestReaction,
  type GitHubReview,
  type GitHubReviewComment,
} from "./collector-github.ts";
import type { CollectorEvidenceRecord, HeadRelation } from "./collector-evidence.ts";

export type GitHubIdentityMaterial = GitHubReview | GitHubIssueComment | GitHubReviewComment | GitHubPullRequestReaction;

export type CollectorMaterialRef = {
  kind: "review" | "issue_comment" | "review_comment" | "reaction";
  id: number;
  /** Receipt-local immutable source reference. */
  evidenceId?: string;
  headRelation?: HeadRelation | "unbound";
};

export type CollectorFinding = {
  identity: GitHubMachineIdentity;
  source: CollectorMaterialRef;
  category: "inline" | "material";
  body: string;
};

export type CollectorIdentityGroup = {
  identity: GitHubMachineIdentity | null;
  /** Human-readable metadata only; never participates in grouping. */
  displayLogin?: string;
  attendance?: true;
  findings?: CollectorFinding[];
  materials: CollectorMaterialRef[];
};

function materialKind(material: GitHubIdentityMaterial): CollectorIdentityGroup["materials"][number]["kind"] {
  if ("pullRequestReviewId" in material) return "review_comment";
  if ("state" in material) return "review";
  if ("content" in material) return "reaction";
  return "issue_comment";
}

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

/** Group observed GitHub materials only by API machine identity fields. */
export function groupGitHubMaterialsByIdentity(
  materials: readonly GitHubIdentityMaterial[],
): CollectorIdentityGroup[] {
  const groups = new Map<string, CollectorIdentityGroup>();
  for (const material of materials) {
    const identity = material.machineIdentity ?? null;
    const key = identityKey(identity);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        identity,
        ...(material.userLogin === null ? {} : { displayLogin: material.userLogin }),
        materials: [],
      };
      groups.set(key, group);
    } else {
      group.identity = mergeMachineIdentity(group.identity, identity);
    }
    group.materials.push({ kind: materialKind(material), id: material.id });
  }
  return [...groups.values()];
}

const CODEX_USER_ID = 199175422;
const CODERABBIT_USER_ID = 136622811;
export type ExtractedCollectorIdentityGroup = CollectorIdentityGroup & {
  attendance: true;
  findings: CollectorFinding[];
};

/** Extract attendance and provider findings without using login/display text as identity. */
export function extractGitHubIdentityGroups(materials: readonly GitHubIdentityMaterial[]): ExtractedCollectorIdentityGroup[] {
  const groups = groupGitHubMaterialsByIdentity(materials);
  const byKey = new Map(groups.map((group) => [identityKey(group.identity), group]));
  for (const group of groups) {
    group.attendance = true;
    group.findings = [];
  }
  for (const material of materials) {
    const identity = material.machineIdentity ?? null;
    const group = byKey.get(identityKey(identity))!;
    if (identity === null) continue;
    const source = { kind: materialKind(material), id: material.id };
    if (source.kind === "review_comment" && "body" in material && (identity.userId === CODEX_USER_ID || identity.userId === CODERABBIT_USER_ID)) {
      group.findings!.push({ identity, source, category: "inline", body: material.body });
    } else if (source.kind === "review" && "body" in material && identity.userId === CODERABBIT_USER_ID) {
      // CodeRabbit review markup is opaque LLM material. Preserve it whole;
      // deterministic code must not split or classify its HTML containers.
      group.findings!.push({ identity, source, category: "material", body: material.body });
    }
  }
  return groups as ExtractedCollectorIdentityGroup[];
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
      headRelation: record.commitOid === undefined || record.commitOid === null
        ? "unbound"
        : record.commitOid === targetHead ? "current" : "prior",
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
    if (identity === null || record.body === undefined) continue;
    if (kind === "review_comment" && (identity.userId === CODEX_USER_ID || identity.userId === CODERABBIT_USER_ID)) {
      group.findings.push({ identity, source: { ...source }, category: "inline", body: record.body });
    } else if (kind === "review" && identity.userId === CODERABBIT_USER_ID) {
      group.findings.push({ identity, source: { ...source }, category: "material", body: record.body });
    }
  }
  return [...groups.values()];
}
