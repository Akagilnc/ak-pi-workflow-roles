import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { immutableReviewerRefs, parseReviewerRefSnapshot, reviewerRefSnapshotArgs, type ReviewerRefMap } from "./reviewer-git-snapshot.ts";
import { sha256Hex } from "./sha256.ts";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.ts";

export type ReviewerObjectFormat = "sha1" | "sha256";
export type ReviewerPinnedTarget = Readonly<{
  repositoryRoot: string;
  objectFormat: ReviewerObjectFormat;
  targetHead: string;
  refs: ReviewerRefMap;
}>;
export type ReviewerRange = Readonly<{
  base: string;
  target: string;
  diffCommand: string;
  diffSha256: string;
  commits: readonly string[];
}>;
export type ReviewerOriginRepository = Readonly<{ owner: string; repo: string }>;

export type ReviewerPinnedGitReader = {
  pin: ReviewerPinnedTarget;
  snapshot(): Promise<ReviewerPinnedTarget>;
  resolve(base: string): Promise<string>;
  range(base: string): Promise<ReviewerRange>;
  /**
   * Branch/feature name tokens at the pinned target for Spec *path* matching only.
   * Derived from the pinned ref snapshot (heads/tags/remotes pointing at targetHead);
   * does not depend on current symbolic HEAD, so detached/remote-only tips stay honest.
   * Ticket-number branch provenance must not use this set — see branchNamesAtPinnedHead.
   */
  featureTokens(): Promise<readonly string[]>;
  /**
   * Durable Spec-candidate paths present in the pinned target tree under docs/specs/.scratch.
   * Spec child clones this target — live working tree is not a source of material facts.
   * Empty list is confirmed absence; other Git/I-O failures propagate with true cause.
   */
  listSpecCandidatePaths(): Promise<readonly string[]>;
  /**
   * github.com owner/repo from `origin` remote at the pinned repository root.
   * undefined = no remote / non-github / unparseable — self-fetch unavailable (degrade).
   */
  originRepository(): Promise<ReviewerOriginRepository | undefined>;
  /**
   * Commit subjects for base..targetHead, newest first (for #N ticket extraction).
   * Empty when the range has no commits; other Git failures propagate with true cause.
   */
  commitMessagesNewestFirst(base: string): Promise<readonly string[]>;
  /**
   * Read one path from the pinned target tree as UTF-8 text.
   * undefined = path absent at targetHead; other Git failures propagate with true cause.
   */
  readPinnedText(path: string): Promise<string | undefined>;
};

const execFileAsync = promisify(execFile);
type GitProcessError = Error & Readonly<{ code: number | string | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; stderr: string; stdout: string }>;
async function execGit<T extends "utf8" | "buffer">(args: readonly string[], options: { encoding: T; maxBuffer?: number }): Promise<{ stdout: T extends "buffer" ? Buffer : string; stderr: string }> {
  // Pin C locale at the sole Git exec seam so English diagnostic classifiers stay honest under translated gettext installs.
  try {
    return await execFileAsync("git", args, {
      ...options,
      env: { ...process.env, LC_ALL: "C" },
    }) as unknown as { stdout: T extends "buffer" ? Buffer : string; stderr: string };
  } catch (error) {
    const source = error as Partial<GitProcessError>;
    const wrapped = new Error("git process failed", { cause: error }) as GitProcessError;
    Object.assign(wrapped, { code: source.code ?? null, signal: source.signal ?? null, timedOut: (source as { killed?: unknown }).killed === true && source.signal === "SIGTERM", aborted: source.name === "AbortError", stderr: String(source.stderr ?? ""), stdout: String(source.stdout ?? "") });
    throw wrapped;
  }
}
function exitCode(error: unknown): number | undefined { const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined; return typeof code === "number" ? code : undefined; }
function gitStderr(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : "";
}
/** Confirmed `origin` remote absence only (`git remote get-url origin`). */
function isConfirmedMissingOriginRemote(error: unknown): boolean {
  return /No such remote ['"]origin['"]/.test(gitStderr(error));
}
/** Confirmed path-at-pinned-tree absence only — exit 128 alone is not enough. */
function isConfirmedPinnedPathAbsent(error: unknown, path: string): boolean {
  const stderr = gitStderr(error);
  const quoted = `'${path}'`;
  return (
    stderr.includes(`path ${quoted} does not exist in `) ||
    stderr.includes(`path ${quoted} exists on disk, but not in `)
  );
}
async function repositoryIsAvailable(root: string): Promise<{ available: boolean; cause?: unknown }> { try { await access(`${root}/.git`); return { available: true }; } catch (cause) { return { available: false, cause }; } }
export const immutableReviewerPin = (pin: ReviewerPinnedTarget): ReviewerPinnedTarget => Object.freeze({
  repositoryRoot: pin.repositoryRoot, objectFormat: pin.objectFormat, targetHead: pin.targetHead, refs: immutableReviewerRefs(pin.refs),
});

/** Short name from a full ref, stripping heads/tags/remotes namespaces (and remote remote-name). */
function shortNameFromPinnedRef(refName: string): string | undefined {
  const short = refName.startsWith("refs/heads/")
    ? refName.slice("refs/heads/".length)
    : refName.startsWith("refs/tags/")
      ? refName.slice("refs/tags/".length)
      : refName.startsWith("refs/remotes/")
        ? refName.slice("refs/remotes/".length).replace(/^[^/]+\//, "")
        : refName;
  const trimmed = short.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Branch-only short names at pinned targetHead for ticket-number provenance (#343).
 * Heads and remotes only — tags never supply branch-token ticket candidates.
 */
export function branchNamesAtPinnedHead(pin: ReviewerPinnedTarget): readonly string[] {
  const names = new Set<string>();
  for (const [refName, entry] of Object.entries(pin.refs)) {
    if (entry.peeledCommitId !== pin.targetHead) continue;
    if (!refName.startsWith("refs/heads/") && !refName.startsWith("refs/remotes/")) continue;
    const short = shortNameFromPinnedRef(refName);
    if (short !== undefined) names.add(short);
  }
  return Object.freeze([...names]);
}
async function gitText(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execGit(["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

/** Concrete fixed-point Git I/O; dispatch owns all policy applied to these reads. */
export async function createReviewerPinnedGitReader(root = process.cwd()): Promise<ReviewerPinnedGitReader> {
  const discoveredRoot = await gitText(root, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(discoveredRoot);
  const objectFormat = await gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format");
  const oidWidth = objectFormat === "sha1" ? 40 : 64;
  const targetHead = await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
  const reachableCommitIds = Object.freeze((await gitText(repositoryRoot, ["rev-list", targetHead])).split("\n").filter(Boolean));
  const refs = parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs()));
  const pin = immutableReviewerPin({ repositoryRoot, objectFormat, targetHead, refs });
  const invalid = (
    code: "base-invalid" | "range-invalid",
    diagnostic: string,
    cause?: unknown,
  ): never => {
    throw new ReviewerCorrectablePreflightError(code, diagnostic, cause === undefined ? undefined : { cause });
  };
  const symbolic = (base: string): string | undefined => {
    const selected = Object.hasOwn(refs, base) ? base : (() => {
      const candidates = [`refs/heads/${base}`, `refs/tags/${base}`, `refs/remotes/${base}`].filter((name) => Object.hasOwn(refs, name));
      if (candidates.length > 1) invalid("base-invalid", "base revision is ambiguous across pinned refs");
      return candidates[0];
    })();
    if (selected === undefined) return undefined;
    const commit = refs[selected]?.peeledCommitId;
    if (commit === null) invalid("base-invalid", "base revision ref must resolve to a commit");
    return commit ?? undefined;
  };
  return Object.freeze({
    pin,
    async snapshot() {
      const liveObjectFormat = await gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
      if (liveObjectFormat !== "sha1" && liveObjectFormat !== "sha256") throw new Error("Unsupported Git object format");
      return immutableReviewerPin({ repositoryRoot, objectFormat: liveObjectFormat, targetHead: await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]), refs: parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs())) });
    },
    async resolve(base: string) {
      if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) || base.startsWith("-") || base.includes("..") || base.includes("@{")) {
        invalid("base-invalid", "base revision syntax is invalid or uses a forbidden revision form");
      }
      let commit: string | undefined;
      const headExpression = /^HEAD((?:~[0-9]+|\^[0-9]+)*)$/.exec(base);
      if (headExpression) {
        try {
          commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${targetHead}${headExpression[1]}^{commit}`]);
        } catch (error) {
          if (exitCode(error) === 128) {
            const repository = await repositoryIsAvailable(repositoryRoot);
            if (repository.available) invalid("base-invalid", "base revision HEAD ancestry expression must resolve to a reachable commit", error);
          }
          throw error;
        }
      } else if (new RegExp(`^[0-9a-f]{${oidWidth}}$`).test(base)) commit = base;
      else if (new RegExp(`^[0-9a-f]{4,${oidWidth - 1}}$`).test(base) && !(objectFormat === "sha256" && base.length === 40)) {
        const matches = reachableCommitIds.filter((candidate) => candidate.startsWith(base));
        if (matches.length !== 1) invalid("base-invalid", "base revision abbreviation must identify exactly one reachable commit");
        commit = matches[0];
      } else commit = symbolic(base);
      if (commit === undefined) invalid("base-invalid", "base revision must name an existing pinned ref or reachable commit");
      try { commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]); } catch (error) {
        if (exitCode(error) === 128) {
          const repository = await repositoryIsAvailable(repositoryRoot);
          if (repository.available) invalid("base-invalid", "base revision must resolve to an existing commit", error);
        }
        throw error;
      }
      try { await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]); } catch (error) {
        if (exitCode(error) === 1) invalid("base-invalid", "base revision must be an ancestor of the pinned target", error);
        throw error;
      }
      return commit;
    },
    async range(base: string) {
      let mergeBase: string;
      try {
        mergeBase = await gitText(repositoryRoot, ["merge-base", base, targetHead]);
      } catch (error) {
        if (exitCode(error) === 1) {
          invalid("range-invalid", "review range requires a common ancestor for base and pinned target", error);
        }
        throw error;
      }
      if (!mergeBase) invalid("range-invalid", "review range requires a common ancestor for base and pinned target");
      const diffCommand = `git diff ${mergeBase}...${targetHead}`;
      const [{ stdout: diff }, commitsText] = await Promise.all([
        execGit(["-C", repositoryRoot, "diff", `${mergeBase}...${targetHead}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }),
        gitText(repositoryRoot, ["rev-list", "--reverse", `${mergeBase}..${targetHead}`]),
      ]);
      if (diff.length === 0) invalid("range-invalid", "review range must contain a non-empty diff between base and pinned target");
      return Object.freeze({ base: mergeBase, target: targetHead, diffCommand, diffSha256: sha256Hex(Uint8Array.from(diff)), commits: Object.freeze(commitsText ? commitsText.split("\n") : []) });
    },
    async featureTokens() {
      // Pinned ref snapshot is the target-tree fact — no live branch/symbolic-ref walk,
      // no catch-to-empty. Detached/remote-only tips surface via refs/remotes/* entries.
      // Includes tags for local Spec-path matching only; ticket branch source is separate.
      const names = new Set<string>();
      for (const [refName, entry] of Object.entries(pin.refs)) {
        if (entry.peeledCommitId !== targetHead) continue;
        const short = shortNameFromPinnedRef(refName);
        if (short !== undefined) names.add(short);
      }
      return Object.freeze([...names]);
    },
    async listSpecCandidatePaths() {
      const roots = ["docs", "specs", ".scratch"] as const;
      // git ls-tree exits 0 with empty stdout when none of the roots exist at targetHead.
      // Other Git/I-O failures keep their true cause for the dispatch preflight path.
      const text = await gitText(repositoryRoot, [
        "ls-tree",
        "-r",
        "--name-only",
        targetHead,
        "--",
        ...roots,
      ]);
      return Object.freeze(text === "" ? [] : text.split("\n").filter((line) => line.length > 0));
    },
    async originRepository() {
      let remoteUrl: string;
      try {
        remoteUrl = await gitText(repositoryRoot, ["remote", "get-url", "origin"]);
      } catch (error) {
        // Only confirmed origin absence softens to unavailable; other Git failures keep true cause.
        if (isConfirmedMissingOriginRemote(error)) return undefined;
        throw error;
      }
      // Non-github / unparseable remote URL = self-fetch unavailable (soft degrade).
      return parseGitHubOriginRemote(remoteUrl);
    },
    async commitMessagesNewestFirst(base: string) {
      const text = await gitText(repositoryRoot, [
        "log",
        "--format=%s",
        `${base}..${targetHead}`,
      ]);
      return Object.freeze(text === "" ? [] : text.split("\n"));
    },
    async readPinnedText(path: string) {
      // Reject path traversal / absolute paths — Spec material is relative tree paths only.
      if (
        path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\0") ||
        path.split("/").some((part) => part === ".." || part === "")
      ) {
        return undefined;
      }
      try {
        const { stdout } = await execGit(
          ["-C", repositoryRoot, "show", `${targetHead}:${path}`],
          { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        );
        return stdout;
      } catch (error) {
        // Only confirmed path-at-pinned-tree absence softens to missing; exit 128 is not a blanket.
        if (isConfirmedPinnedPathAbsent(error, path)) return undefined;
        throw error;
      }
    },

  });
}

/**
 * Parse github.com owner/repo from a git remote URL.
 * Supports scp-like SSH, ssh://, https://, and git:// shapes. Soft: undefined when not github.
 */
export function parseGitHubOriginRemote(remoteUrl: string): ReviewerOriginRepository | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return undefined;
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) return normalizeOrigin(scp[1]!, scp[2]!);
  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh) return normalizeOrigin(ssh[1]!, ssh[2]!);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (!/^github\.com$/i.test(parsed.hostname)) return undefined;
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return undefined;
  return normalizeOrigin(parts[0]!, parts[1]!);
}

function normalizeOrigin(ownerRaw: string, repoRaw: string): ReviewerOriginRepository | undefined {
  const owner = ownerRaw.trim();
  const repo = stripGitSuffix(repoRaw.trim());
  if (owner.length === 0 || repo.length === 0) return undefined;
  // Conservative identity: no path separators or URL material inside segments.
  if (/[/?#@\\]/.test(owner) || /[/?#@\\]/.test(repo)) return undefined;
  return Object.freeze({ owner, repo });
}

function stripGitSuffix(name: string): string {
  return name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
}
