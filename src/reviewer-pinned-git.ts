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
export type ReviewerPinnedGitReader = {
  pin: ReviewerPinnedTarget;
  snapshot(): Promise<ReviewerPinnedTarget>;
  resolve(base: string): Promise<string>;
  range(base: string): Promise<ReviewerRange>;
};

const execFileAsync = promisify(execFile);
type GitProcessError = Error & Readonly<{ code: number | string | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean; stderr: string; stdout: string }>;
async function execGit<T extends "utf8" | "buffer">(args: readonly string[], options: { encoding: T; maxBuffer?: number }): Promise<{ stdout: T extends "buffer" ? Buffer : string; stderr: string }> {
  try { return await execFileAsync("git", args, options) as unknown as { stdout: T extends "buffer" ? Buffer : string; stderr: string }; }
  catch (error) {
    const source = error as Partial<GitProcessError>;
    const wrapped = new Error("git process failed", { cause: error }) as GitProcessError;
    Object.assign(wrapped, { code: source.code ?? null, signal: source.signal ?? null, timedOut: (source as { killed?: unknown }).killed === true && source.signal === "SIGTERM", aborted: source.name === "AbortError", stderr: String(source.stderr ?? ""), stdout: String(source.stdout ?? "") });
    throw wrapped;
  }
}
function exitCode(error: unknown): number | undefined { const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined; return typeof code === "number" ? code : undefined; }
async function repositoryIsAvailable(root: string): Promise<{ available: boolean; cause?: unknown }> { try { await access(`${root}/.git`); return { available: true }; } catch (cause) { return { available: false, cause }; } }
export const immutableReviewerPin = (pin: ReviewerPinnedTarget): ReviewerPinnedTarget => Object.freeze({
  repositoryRoot: pin.repositoryRoot, objectFormat: pin.objectFormat, targetHead: pin.targetHead, refs: immutableReviewerRefs(pin.refs),
});
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

  });
}
