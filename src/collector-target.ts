/**
 * #676 D1: Collector admission target recognition.
 * Explicit PR wins; otherwise resolve a unique PR for the current branch head
 * via existing gh api. Zero or many candidates → require the caller to clarify.
 */
import { execFileSync } from "node:child_process";

import type { CollectorRepository } from "./collector-config.ts";
import {
  createGhApiRunner,
  type GhApiRunner,
} from "./collector-github.ts";
import { CliUsageError } from "./public-cli/cli-errors.ts";

export type CollectorTargetResolution =
  | { readonly kind: "explicit"; readonly prNumber: number }
  | { readonly kind: "branch-head"; readonly prNumber: number; readonly branch: string };

export type ResolveCollectorTargetInput = {
  readonly projectRoot: string;
  readonly repository: CollectorRepository;
  /** Caller-provided PR number when already explicit. */
  readonly explicitPrNumber?: number;
  /** Optional gh runner injection for tests. */
  readonly runner?: GhApiRunner;
  /** Optional branch override for tests (skips git rev-parse). */
  readonly currentBranch?: string;
};

function ambiguousTarget(detail: string): never {
  throw new CliUsageError(
    `collector target is ambiguous: ${detail}; pass an explicit --pr`,
  );
}

function readCurrentBranch(projectRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new CliUsageError(
      "collector target is ambiguous: cannot read current git branch; pass an explicit --pr",
      { cause: error },
    );
  }
}

/**
 * Resolve the Collector PR target without guessing.
 * - Explicit `--pr` → that number.
 * - Otherwise: unique PR whose head is the current branch (state=all).
 * - 0 or >1 candidates, detached HEAD, or transport failure → require explicit `--pr`.
 */
export async function resolveCollectorTarget(
  input: ResolveCollectorTargetInput,
): Promise<CollectorTargetResolution> {
  if (input.explicitPrNumber !== undefined) {
    return { kind: "explicit", prNumber: input.explicitPrNumber };
  }

  const branch = (input.currentBranch ?? readCurrentBranch(input.projectRoot)).trim();
  if (branch.length === 0 || branch === "HEAD") {
    ambiguousTarget("detached HEAD and no --pr");
  }

  const runner = input.runner ?? createGhApiRunner();
  const { owner, repo } = input.repository;
  // Same-repo head filter: owner:branch. Online association only — no prose scrape.
  const path =
    `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`;

  let response;
  try {
    response = await runner([
      "api",
      "--hostname",
      "github.com",
      "--include",
      "-X",
      "GET",
      path,
    ]);
  } catch (error) {
    throw new CliUsageError(
      "collector target is ambiguous: failed to look up branch PR association; pass an explicit --pr",
      { cause: error },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    ambiguousTarget(
      `branch PR lookup HTTP ${response.status} for ${owner}/${repo}@${branch}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch (error) {
    throw new CliUsageError(
      "collector target is ambiguous: branch PR lookup returned non-JSON; pass an explicit --pr",
      { cause: error },
    );
  }

  if (!Array.isArray(parsed)) {
    ambiguousTarget("branch PR lookup payload is not a list");
  }

  const numbers: number[] = [];
  for (const item of parsed) {
    if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { number?: unknown }).number === "number" &&
      Number.isSafeInteger((item as { number: number }).number) &&
      (item as { number: number }).number >= 1
    ) {
      numbers.push((item as { number: number }).number);
    }
  }

  const unique = [...new Set(numbers)];
  if (unique.length === 0) {
    ambiguousTarget(`no PR associated with branch ${branch}`);
  }
  if (unique.length > 1) {
    ambiguousTarget(
      `multiple PRs associated with branch ${branch}: ${unique.join(", ")}`,
    );
  }

  return {
    kind: "branch-head",
    prNumber: unique[0]!,
    branch,
  };
}
