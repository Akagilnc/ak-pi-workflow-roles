/**
 * #676 D1: Collector admission target recognition.
 * Explicit PR wins; otherwise resolve a unique PR from branch upstream head and/or
 * current HEAD online association. Zero or many candidates → require the caller to
 * clarify. No guessing. Git/config/transport failures keep true cause (not washed
 * into target ambiguity).
 */
import { execFileSync } from "node:child_process";

import type { CollectorRepository } from "./collector-config.ts";
import {
  createGhApiRunner,
  listPullRequestNumbersByCommit,
  listPullRequestNumbersByHead,
} from "./collector-github.ts";
import { CliUsageError } from "./public-cli/cli-errors.ts";

export type ResolveCollectorTargetInput = {
  readonly projectRoot: string;
  readonly repository: CollectorRepository;
  /** Caller-provided PR number when already explicit. */
  readonly explicitPrNumber?: number;
};

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
 * Resolve the Collector PR target without guessing.
 * - Explicit `--pr` → that number.
 * - Otherwise: unique PR from structured upstream head owner:ref and/or HEAD commit association.
 * - 0 or >1 candidates, detached HEAD → require explicit `--pr` (CliUsageError).
 * - Git/config/transport/HTTP/JSON failures propagate with true cause (not washed into ambiguity).
 * - Never use base-owner:local-branch as sole target basis; never lock a wrong unique head hit
 *   by skipping commit association after a misread local branch name.
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
  const runner = createGhApiRunner();
  const { owner, repo } = input.repository;
  const upstream = readUpstreamHeadBinding(input.projectRoot, branch);

  const numbers: number[] = [];
  // Prefer structured head owner:ref from real upstream merge binding (fork-safe; local≠upstream name).
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
  // Commit association covers same-repo and fork PRs that contain the current HEAD.
  // Always available when head lookup is empty — never base-owner:local-branch as sole basis.
  if (numbers.length === 0) {
    numbers.push(
      ...(await listPullRequestNumbersByCommit(runner, {
        owner,
        repo,
        commitSha: headSha,
      })),
    );
  }

  const unique = [...new Set(numbers)];
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
