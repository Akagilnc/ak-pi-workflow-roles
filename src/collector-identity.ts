import type {
  GitHubIssueComment,
  GitHubMachineIdentity,
  GitHubReview,
  GitHubReviewComment,
} from "./collector-github.ts";

export type GitHubIdentityMaterial = GitHubReview | GitHubIssueComment | GitHubReviewComment;

export type CollectorIdentityGroup = {
  identity: GitHubMachineIdentity | null;
  /** Human-readable metadata only; never participates in grouping. */
  displayLogin?: string;
  materials: Array<{
    kind: "review" | "issue_comment" | "review_comment";
    id: number;
  }>;
};

function materialKind(material: GitHubIdentityMaterial): CollectorIdentityGroup["materials"][number]["kind"] {
  if ("pullRequestReviewId" in material) return "review_comment";
  if ("state" in material) return "review";
  return "issue_comment";
}

function identityKey(identity: GitHubMachineIdentity | null): string {
  if (identity === null) return "unassigned";
  return `${identity.userType}:${identity.userId}:${identity.appId ?? "none"}`;
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
