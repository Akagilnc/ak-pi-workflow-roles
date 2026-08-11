import {
  normalizeIssueComment,
  normalizePullRequestReaction,
  normalizeReview,
  normalizeReviewComment,
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
  category: "inline" | "outside_diff" | "nitpick" | "material";
  body: string;
};

export type CollectorIdentityGroup = {
  identity: GitHubMachineIdentity | null;
  /** Human-readable metadata only; never participates in grouping. */
  displayLogin?: string;
  attendance?: true;
  degraded?: boolean;
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
  // The stable user type/id pair is the grouping identity; appId is retained
  // when observed but must not split one actor across transport surfaces.
  return String(identity.userId);
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
    }
    group.materials.push({ kind: materialKind(material), id: material.id });
  }
  return [...groups.values()];
}

const CODEX_USER_ID = 199175422;
const CODERABBIT_USER_ID = 136622811;
function foldedCodeRabbitFindings(body: string, identity: GitHubMachineIdentity, source: CollectorMaterialRef): CollectorFinding[] {
  const findings: CollectorFinding[] = [];
  const stack: Array<{ start: number; rootId: number }> = [];
  let rootContainerCount = 0;
  const findingRoots = new Map<number, "outside_diff" | "nitpick">();
  const tokens = /<details>|<\/details>|<summary>[\s\S]*?<\/summary>|<!--\s*cr-comment:v1:[^>]+-->/gi;
  for (const match of body.matchAll(tokens)) {
    const token = match[0].toLowerCase();
    if (token === "<details>") {
      if (stack.length === 0) rootContainerCount += 1;
      stack.push({
        start: match.index! + match[0].length,
        rootId: stack.at(-1)?.rootId ?? rootContainerCount,
      });
    } else if (token === "</details>") {
      stack.pop();
    } else if (token.startsWith("<summary>")) {
      const current = stack.at(-1);
      if (current !== undefined) current.start = match.index! + match[0].length;
    } else if (stack.length >= 2) {
      const leaf = stack.at(-1)!;
      let category = findingRoots.get(leaf.rootId);
      if (category === undefined && findingRoots.size < 2) {
        category = findingRoots.size === 0 ? "outside_diff" : "nitpick";
        findingRoots.set(leaf.rootId, category);
      }
      if (category === undefined) continue;
      findings.push({
        identity,
        source,
        category,
        body: body.slice(leaf.start, match.index).trim(),
      });
    }
  }
  return findings;
}

export type ExtractedCollectorIdentityGroup = CollectorIdentityGroup & {
  attendance: true;
  degraded: boolean;
  findings: CollectorFinding[];
};

/** Extract attendance and provider findings without using login/display text as identity. */
export function extractGitHubIdentityGroups(materials: readonly GitHubIdentityMaterial[]): ExtractedCollectorIdentityGroup[] {
  const groups = groupGitHubMaterialsByIdentity(materials);
  const byKey = new Map(groups.map((group) => [identityKey(group.identity), group]));
  for (const group of groups) {
    group.attendance = true;
    group.degraded = false;
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
      group.findings!.push(...foldedCodeRabbitFindings(material.body, identity, source));
    }
  }
  return groups as ExtractedCollectorIdentityGroup[];
}

/**
 * Receipt adapter: run the source extractors over retained GitHub bytes, then
 * replace transport IDs with closure-checked evidence refs and HEAD relation.
 */
export function extractCollectorEvidenceIdentityGroups(
  records: readonly CollectorEvidenceRecord[],
  targetHead: string,
): ExtractedCollectorIdentityGroup[] {
  const supported: Array<{
    record: CollectorEvidenceRecord;
    material: GitHubIdentityMaterial;
  }> = [];
  for (const record of records) {
    try {
      if (record.kind === "review") supported.push({ record, material: normalizeReview(record.raw) });
      if (record.kind === "issue_comment") supported.push({ record, material: normalizeIssueComment(record.raw) });
      if (record.kind === "review_comment") supported.push({ record, material: normalizeReviewComment(record.raw) });
      if (record.kind === "reaction") supported.push({ record, material: normalizePullRequestReaction(record.raw) });
    } catch {
      // Raw transport failures remain evidenceRecords, but cannot impersonate
      // typed attendance when their retained bytes do not normalize.
    }
  }
  const groups = new Map<string, ExtractedCollectorIdentityGroup>();
  for (const { record, material } of supported) {
    const extracted = extractGitHubIdentityGroups([material])[0]!;
    const bind = (source: CollectorMaterialRef) => {
      source.evidenceId = record.evidenceId;
      source.headRelation = record.commitOid === undefined || record.commitOid === null
        ? "unbound"
        : record.commitOid === targetHead ? "current" : "prior";
    };
    for (const source of extracted.materials) bind(source);
    for (const finding of extracted.findings) bind(finding.source);
    const key = identityKey(extracted.identity);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, extracted);
    } else {
      existing.materials.push(...extracted.materials);
      existing.findings.push(...extracted.findings);
      existing.degraded ||= extracted.degraded;
    }
  }
  return [...groups.values()];
}
