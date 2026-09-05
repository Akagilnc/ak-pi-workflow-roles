/**
 * #676 D1: Collector admission target recognition on the shared execution seam.
 * Explicit PR wins (no association queries). Otherwise gather online candidates from
 * structured upstream head, HEAD commit association, and task materials' structured
 * ticket refs (issue/PR URLs, #N tokens, typed JSON fields, issues/N paths) resolved
 * through existing GitHub association. Deduped unique → bind; 0 or many → require
 * explicit --pr. No prose-digit scrape, no second state machine, no branch-only
 * substitute that skips conflicting evidence. Git/config/transport failures keep true cause.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { CollectorRepository } from "./collector-config.ts";
import {
  createGhApiRunner,
  listPullRequestNumbersByCommit,
  listPullRequestNumbersByHead,
  listPullRequestNumbersByTicket,
} from "./collector-github.ts";
import { instructionContainsTicketNumber } from "./diarist-ticket-resolution.ts";
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
  /** Real call instruction (available before target bind). */
  readonly instruction?: string;
  /** Frozen attachment paths whose structured contents may name issue/PR. */
  readonly attachmentPaths?: readonly string[];
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
 * Structured ticket refs only — not bare prose digit scrape (#676 D1):
 * - #N tokens
 * - github.com/owner/repo/(pull|issues)/N URLs
 * - .../issues/N/... path segments
 * - typed JSON keys prNumber|issueNumber|ticketNumber when whole text is JSON
 */
export function structuredTicketRefsFromMaterials(
  instruction: string,
  attachmentTexts: readonly string[],
): number[] {
  const found = new Set<number>();
  const absorb = (text: string): void => {
    for (const match of text.matchAll(/#([1-9]\d*)\b/g)) {
      found.add(Number(match[1]));
    }
    for (const match of text.matchAll(
      /github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/([1-9]\d*)\b/gi,
    )) {
      found.add(Number(match[1]));
    }
    for (const match of text.matchAll(/(?:^|\/)issues\/([1-9]\d*)(?:\/|$)/g)) {
      found.add(Number(match[1]));
    }
    const trimmed = text.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        collectTypedTicketFields(JSON.parse(trimmed), found);
      } catch {
        // Not JSON — structured path/URL/#N refs above still apply.
      }
    }
  };
  absorb(instruction);
  for (const text of attachmentTexts) absorb(text);
  return [...found];
}

function collectTypedTicketFields(value: unknown, into: Set<number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedTicketFields(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["prNumber", "issueNumber", "ticketNumber"] as const) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1) {
      into.add(raw);
    } else if (typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())) {
      into.add(Number(raw.trim()));
    }
  }
  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === "object") {
      collectTypedTicketFields(nested, into);
    }
  }
}

async function readAttachmentTexts(
  paths: readonly string[],
): Promise<readonly string[]> {
  const texts: string[] = [];
  for (const path of paths) {
    try {
      // Cap each attachment read — structured refs live near the head of task materials.
      const body = await readFile(path, "utf8");
      texts.push(body.length > 256_000 ? body.slice(0, 256_000) : body);
      // Path itself may carry issues/N segments.
      texts.push(path);
    } catch {
      // Unreadable attachment still contributes its path string for issues/N segments.
      texts.push(path);
    }
  }
  return texts;
}

/**
 * Resolve the Collector PR target without guessing.
 * - Explicit `--pr` → that number (no association queries).
 * - Otherwise: full online candidates (upstream head + HEAD commit + task ticket
 *   association), deduped; task confirmation narrows multi-candidate sets when a
 *   candidate's complete number appears in the instruction.
 * - 0 or >1 after that → require explicit `--pr` (CliUsageError).
 * - Git/config/transport/HTTP/JSON failures propagate with true cause.
 */
export async function resolveCollectorTarget(
  input: ResolveCollectorTargetInput,
): Promise<{ readonly prNumber: number }> {
  if (input.explicitPrNumber !== undefined) {
    return { prNumber: input.explicitPrNumber };
  }

  const branch = readCurrentBranch(input.projectRoot);
  const detached = branch.length === 0 || branch === "HEAD";
  const instruction = input.instruction ?? "";
  const attachmentTexts = await readAttachmentTexts(input.attachmentPaths ?? []);
  const materialTickets = structuredTicketRefsFromMaterials(instruction, attachmentTexts);

  // Detached HEAD with no structured material tickets cannot associate online.
  if (detached && materialTickets.length === 0) {
    ambiguousTarget("detached HEAD and no --pr");
  }

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
  }

  // Task materials: structured ticket refs → online issue/PR association.
  for (const ticket of materialTickets) {
    numbers.push(
      ...(await listPullRequestNumbersByTicket(runner, {
        owner,
        repo,
        ticketNumber: ticket,
      })),
    );
  }

  let unique = [...new Set(numbers)];

  // Task confirmation: when multiple online hits, keep those whose complete number
  // appears in the instruction (verification, not free-text scrape as sole method).
  if (unique.length > 1 && instruction.trim().length > 0) {
    const confirmed = unique.filter((n) => instructionContainsTicketNumber(instruction, n));
    if (confirmed.length === 1) {
      unique = confirmed;
    } else if (confirmed.length > 1) {
      unique = confirmed;
    }
  }

  if (unique.length === 0) {
    ambiguousTarget(
      detached
        ? `no PR associated with task materials`
        : `no PR associated with branch ${branch} or task materials`,
    );
  }
  if (unique.length > 1) {
    ambiguousTarget(
      `multiple PRs associated with context: ${unique.join(", ")}`,
    );
  }

  return { prNumber: unique[0]! };
}

export { ownerRepoFromGitHubRemoteUrl, ownerFromGitHubRemoteUrl };
