/**
 * #676 D1: Collector admission target recognition on structured git context.
 * Explicit PR wins (no association queries). Otherwise gather online candidates
 * from structured upstream head and HEAD commit association only. Deduped unique
 * → bind; many → require explicit --pr; zero → unbound so the role can decide
 * from task materials via the bind-target business tool. No task-text scrape,
 * no second state machine. Git/config/transport failures keep true cause.
 */
import { execFileSync } from "node:child_process";

import type { CollectorRepository } from "./collector-config.ts";
import {
  createGhApiRunner,
  listPullRequestNumbersByCommit,
  listPullRequestNumbersByHead,
} from "./collector-github.ts";
import { CliUsageError } from "./public-cli/cli-errors.ts";
import {
  ownerFromGitHubRemoteUrl,
  ownerRepoFromGitHubRemoteUrl,
} from "./public-cli/github-remote.ts";

export type ResolveCollectorTargetInput = {
  readonly projectRoot: string;
  readonly repository: CollectorRepository;
  /** Caller-provided PR number when already explicit. */
  readonly explicitPrNumber?: number;
};

export type CollectorTargetResolution =
  | { readonly kind: "bound"; readonly prNumber: number }
  | { readonly kind: "unbound" };

function ambiguousTarget(detail: string, cause?: unknown): never {
  throw new CliUsageError(
    `collector target is ambiguous: ${detail}; pass an explicit --pr`,
    cause === undefined ? undefined : { cause },
  );
}

/** Real git failure — not target ambiguity. Propagates with true cause on exit 1. */
function gitFailure(detail: string, cause: unknown): never {
  throw new Error(`collector git failed: ${detail}`, {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function gitText(projectRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** git config --get exit 1 = key absent; other failures keep true cause. */
function isGitConfigMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 1;
}

function readCurrentBranch(projectRoot: string): string {
  try {
    return gitText(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (error) {
    gitFailure("cannot read current git branch", error);
  }
}

function readHeadSha(projectRoot: string): string {
  try {
    return gitText(projectRoot, ["rev-parse", "HEAD"]);
  } catch (error) {
    gitFailure("cannot read current HEAD", error);
  }
}

/**
 * Head ref short name from branch.<name>.merge (refs/heads/<ref> or bare ref).
 * Non-heads merge forms are not a structured head binding.
 */
function headRefFromMerge(merge: string): string | undefined {
  const trimmed = merge.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("refs/heads/")) {
    const ref = trimmed.slice("refs/heads/".length);
    return ref.length > 0 ? ref : undefined;
  }
  // Reject other refs/* (e.g. refs/remotes/…) — not a PR head ref binding.
  if (trimmed.startsWith("refs/")) return undefined;
  return trimmed;
}

/**
 * Real upstream head owner + head ref from branch.<name>.remote/merge when configured.
 * Missing config keys = not configured (undefined). Config/remote execution failures
 * throw with true cause — never swallowed as "no upstream, keep fallback".
 */
function readUpstreamHeadBinding(
  projectRoot: string,
  branch: string,
): { readonly headOwner: string; readonly headRef: string } | undefined {
  let remote: string | undefined;
  try {
    remote = gitText(projectRoot, ["config", "--get", `branch.${branch}.remote`]);
  } catch (error) {
    if (isGitConfigMissing(error)) remote = undefined;
    else gitFailure(`cannot read branch.${branch}.remote`, error);
  }
  if (remote === undefined || remote.length === 0) return undefined;

  let merge: string | undefined;
  try {
    merge = gitText(projectRoot, ["config", "--get", `branch.${branch}.merge`]);
  } catch (error) {
    if (isGitConfigMissing(error)) merge = undefined;
    else gitFailure(`cannot read branch.${branch}.merge`, error);
  }
  if (merge === undefined || merge.length === 0) return undefined;

  const headRef = headRefFromMerge(merge);
  if (headRef === undefined) return undefined;

  let remoteUrl: string;
  try {
    remoteUrl = gitText(projectRoot, ["remote", "get-url", remote]);
  } catch (error) {
    gitFailure(`cannot read remote URL for ${remote}`, error);
  }
  const headOwner = ownerFromGitHubRemoteUrl(remoteUrl);
  if (headOwner === undefined) return undefined;
  return { headOwner, headRef };
}

/**
 * Resolve the Collector PR target without guessing from task text.
 * - Explicit `--pr` → that number (no association queries).
 * - Otherwise: full online candidates (upstream head + HEAD commit), deduped.
 * - Exactly 1 → bound. >1 → require explicit `--pr`. 0 → unbound (role bind tool).
 * - Git/config/transport/HTTP/JSON failures propagate with true cause.
 */
export async function resolveCollectorTarget(
  input: ResolveCollectorTargetInput,
): Promise<CollectorTargetResolution> {
  if (input.explicitPrNumber !== undefined) {
    return { kind: "bound", prNumber: input.explicitPrNumber };
  }

  const branch = readCurrentBranch(input.projectRoot);
  const detached = branch.length === 0 || branch === "HEAD";

  // Detached HEAD cannot associate via branch head; commit association still runs.
  const runner = createGhApiRunner();
  const { owner, repo } = input.repository;
  const numbers: number[] = [];

  if (!detached) {
    const headSha = readHeadSha(input.projectRoot);
    const upstream = readUpstreamHeadBinding(input.projectRoot, branch);

    // Prefer structured head owner:ref from real upstream merge binding (fork-safe).
    if (upstream !== undefined) {
      numbers.push(
        ...(await listPullRequestNumbersByHead(runner, {
          owner,
          repo,
          headOwner: upstream.headOwner,
          headRef: upstream.headRef,
        })),
      );
    }
    // Always also take commit association — never let a sole upstream hit hide a conflict.
    numbers.push(
      ...(await listPullRequestNumbersByCommit(runner, {
        owner,
        repo,
        commitSha: headSha,
      })),
    );
  } else {
    // Detached: commit association only (no branch head).
    const headSha = readHeadSha(input.projectRoot);
    numbers.push(
      ...(await listPullRequestNumbersByCommit(runner, {
        owner,
        repo,
        commitSha: headSha,
      })),
    );
  }

  const unique = [...new Set(numbers)];

  if (unique.length === 1) {
    return { kind: "bound", prNumber: unique[0]! };
  }
  if (unique.length > 1) {
    ambiguousTarget(
      `multiple PRs associated with context: ${unique.join(", ")}`,
    );
  }
  // Zero structured git hits — leave unbound so the role can decide from materials.
  return { kind: "unbound" };
}

export { ownerRepoFromGitHubRemoteUrl, ownerFromGitHubRemoteUrl };
