import type {
  GitHubIssueComment,
  GitHubMachineIdentity,
  GitHubReview,
  GitHubReviewComment,
} from "./collector-github.ts";

export type GitHubIdentityMaterial = GitHubReview | GitHubIssueComment | GitHubReviewComment;

export type CollectorMaterialRef = {
  kind: "review" | "issue_comment" | "review_comment";
  id: number;
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

const CODEX_USER_ID = 199175422;
const CODERABBIT_USER_ID = 136622811;
const SOURCERY_USER_ID = 58596630;

function foldedCodeRabbitFindings(body: string, identity: GitHubMachineIdentity, source: CollectorMaterialRef): CollectorFinding[] {
  const findings: CollectorFinding[] = [];
  const stack: Array<{ start: number; summary: string; category?: "outside_diff" | "nitpick" }> = [];
  const tokens = /<details>|<\/details>|<summary>([\s\S]*?)<\/summary>|<!--\s*cr-comment:v1:[^>]+-->/gi;
  for (const match of body.matchAll(tokens)) {
    const token = match[0].toLowerCase();
    if (token === "<details>") {
      stack.push({ start: match.index! + match[0].length, summary: "" });
    } else if (token === "</details>") {
      stack.pop();
    } else if (match[1] !== undefined) {
      const current = stack.at(-1);
      if (current !== undefined) {
        current.summary = match[1].replace(/<[^>]+>/g, "").trim();
        if (/outside diff range comments/i.test(current.summary)) current.category = "outside_diff";
        if (/nitpick comments/i.test(current.summary)) current.category = "nitpick";
      }
    } else {
      const category = [...stack].reverse().find((entry) => entry.category)?.category;
      if (category === undefined) continue;
      const container = [...stack].reverse().find((entry) => entry.summary.length > 0 && entry.category === undefined);
      findings.push({
        identity,
        source,
        category,
        body: body.slice(container?.start ?? match.index!, match.index).trim(),
      });
    }
  }
  return findings;
}

function isDegraded(material: GitHubIdentityMaterial, identity: GitHubMachineIdentity): boolean {
  if (identity.userId === CODEX_USER_ID) return /reached your Codex usage limits for code reviews/i.test(material.body);
  if (identity.userId === SOURCERY_USER_ID) return /Sorry @[\s\S]*(?:rate limit|review limit)/i.test(material.body);
  return false;
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
    if (isDegraded(material, identity)) group.degraded = true;
    if (source.kind === "review_comment" && (identity.userId === CODEX_USER_ID || identity.userId === CODERABBIT_USER_ID)) {
      group.findings!.push({ identity, source, category: "inline", body: material.body });
    } else if (source.kind === "review" && identity.userId === CODERABBIT_USER_ID) {
      group.findings!.push(...foldedCodeRabbitFindings(material.body, identity, source));
    }
  }
  return groups as ExtractedCollectorIdentityGroup[];
}
