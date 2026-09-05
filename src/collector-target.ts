/**
 * #676 D1: Collector admission target recognition.
 * Explicit PR wins; otherwise resolve a unique PR from branch/HEAD online association.
 * Zero or many candidates → require the caller to clarify. No guessing.
 */
import { execFileSync } from "node:child_process";

import type { CollectorRepository } from "./collector-config.ts";
import {
  createGhApiRunner,
  listPullRequestNumbersByCommit,
  listPullRequestNumbersByHead,
  type GhApiRunner,
} from "./collector-github.ts";
import { CliUsageError } from "./public-cli/cli-errors.ts";

export type ResolveCollectorTargetInput = {
  readonly projectRoot: string;
  readonly repository: CollectorRepository;
  /** Caller-provided PR number when already explicit. */
  readonly explicitPrNumber?: number;
  /** Optional gh runner injection for production seams that already own a runner. */
  readonly runner?: GhApiRunner;
};

function ambiguousTarget(detail: string, cause?: unknown): never {
  throw new CliUsageError(
    `collector target is ambiguous: ${detail}; pass an explicit --pr`,
    cause === undefined ? undefined : { cause },
  );
}

function gitText(projectRoot: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readCurrentBranch(projectRoot: string): string {
  try {
    return gitText(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (error) {
    ambiguousTarget("cannot read current git branch", error);
  }
}

function readHeadSha(projectRoot: string): string {
  try {
    return gitText(projectRoot, ["rev-parse", "HEAD"]);
  } catch (error) {
    ambiguousTarget("cannot read current HEAD", error);
  }
}

/** Parse owner from a github.com remote URL; undefined when not a GitHub owner/repo remote. */
function ownerFromGitHubRemoteUrl(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) return scp[1]!.toLowerCase();
  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh) return ssh[1]!.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    if (!/^github\.com$/i.test(parsed.hostname)) return undefined;
    if (parsed.search !== "" || parsed.hash !== "") return undefined;
    const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
    if (parts.length !== 2) return undefined;
    return parts[0]!.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Real head-owner context from the branch upstream remote when configured.
 * Reads branch.<name>.remote (+ merge) first so a configured fork remote counts
 * even before the remote-tracking ref is fetched; does not assume base owner.
 */
function readUpstreamHeadOwner(projectRoot: string, branch: string): string | undefined {
  try {
    const remote = gitText(projectRoot, ["config", "--get", `branch.${branch}.remote`]);
    if (remote.length === 0) return undefined;
    // merge must be present for a real upstream binding; otherwise ignore.
    const merge = gitText(projectRoot, ["config", "--get", `branch.${branch}.merge`]);
    if (merge.length === 0) return undefined;
    const remoteUrl = gitText(projectRoot, ["remote", "get-url", remote]);
    return ownerFromGitHubRemoteUrl(remoteUrl);
  } catch {
    return undefined;
  }
}

function uniquePrNumbers(numbers: readonly number[]): number[] {
  return [...new Set(numbers)];
}

/**
 * Resolve the Collector PR target without guessing.
 * - Explicit `--pr` → that number.
 * - Otherwise: unique PR from branch upstream head owner and/or current HEAD commit association.
 * - 0 or >1 candidates, detached HEAD → require explicit `--pr` (CliUsageError).
 * - Transport/HTTP/JSON failures propagate with true cause (not washed into ambiguity).
 */
export async function resolveCollectorTarget(
  input: ResolveCollectorTargetInput,
): Promise<{ readonly prNumber: number }> {
  if (input.explicitPrNumber !== undefined) {
    return { prNumber: input.explicitPrNumber };
  }

  const branch = readCurrentBranch(input.projectRoot);
  if (branch.length === 0 || branch === "HEAD") {
    ambiguousTarget("detached HEAD and no --pr");
  }

  const headSha = readHeadSha(input.projectRoot);
  const runner = input.runner ?? createGhApiRunner();
  const { owner, repo } = input.repository;
  const headOwner = readUpstreamHeadOwner(input.projectRoot, branch);

  const numbers: number[] = [];
  // Prefer structured head owner:ref when branch upstream names the real head owner (fork-safe).
  if (headOwner !== undefined) {
    numbers.push(
      ...(await listPullRequestNumbersByHead(runner, {
        owner,
        repo,
        headOwner,
        headRef: branch,
      })),
    );
  }
  // Commit association covers same-repo and fork PRs that contain the current HEAD.
  if (numbers.length === 0) {
    numbers.push(
      ...(await listPullRequestNumbersByCommit(runner, {
        owner,
        repo,
        commitSha: headSha,
      })),
    );
  }
  // Last resort: base-owner head filter only when no upstream head owner was available.
  if (numbers.length === 0 && headOwner === undefined) {
    numbers.push(
      ...(await listPullRequestNumbersByHead(runner, {
        owner,
        repo,
        headOwner: owner,
        headRef: branch,
      })),
    );
  }

  const unique = uniquePrNumbers(numbers);
  if (unique.length === 0) {
    ambiguousTarget(
      `no PR associated with branch ${branch} (HEAD ${headSha})`,
    );
  }
  if (unique.length > 1) {
    ambiguousTarget(
      `multiple PRs associated with branch ${branch}: ${unique.join(", ")}`,
    );
  }

  return { prNumber: unique[0]! };
}
