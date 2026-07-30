import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { immutableReviewerRefs, parseReviewerRefSnapshot, reviewerRefSnapshotArgs, type ReviewerRefMap } from "./reviewer-git-snapshot.ts";
import { sha256Hex } from "./sha256.ts";

export type ReviewerPinnedTarget = Readonly<{
  repositoryRoot: string;
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
  material(path: string, revision: string): Promise<Uint8Array>;
};

const execFileAsync = promisify(execFile);
export const immutableReviewerPin = (pin: ReviewerPinnedTarget): ReviewerPinnedTarget => Object.freeze({
  repositoryRoot: pin.repositoryRoot, targetHead: pin.targetHead, refs: immutableReviewerRefs(pin.refs),
});
async function gitText(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

/** Concrete fixed-point Git I/O; dispatch owns all policy applied to these reads. */
export async function createReviewerPinnedGitReader(root = process.cwd()): Promise<ReviewerPinnedGitReader> {
  const discoveredRoot = await gitText(root, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(discoveredRoot);
  const targetHead = await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
  const refs = parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs()));
  const pin = immutableReviewerPin({ repositoryRoot, targetHead, refs });
  const symbolic = (base: string): string | undefined => {
    const selected = Object.hasOwn(refs, base) ? base : (() => {
      const candidates = [`refs/heads/${base}`, `refs/tags/${base}`, `refs/remotes/${base}`].filter((name) => Object.hasOwn(refs, name));
      if (candidates.length > 1) throw new Error("Base revision alias is ambiguous in the pinned ref map");
      return candidates[0];
    })();
    if (selected === undefined) return undefined;
    const commit = refs[selected]?.peeledCommitId;
    if (commit === null) throw new Error("Base revision does not identify a commit");
    return commit;
  };
  return Object.freeze({
    pin,
    async snapshot() {
      return immutableReviewerPin({ repositoryRoot, targetHead: await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]), refs: parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs())) });
    },
    async resolve(base: string) {
      if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) || base.startsWith("-") || base.includes("..") || base.includes("@{")) throw new Error("Unsafe base revision grammar");
      let commit: string | undefined;
      const headExpression = /^HEAD((?:~[0-9]+|\^[0-9]+)*)$/.exec(base);
      if (headExpression) commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${targetHead}${headExpression[1]}^{commit}`]);
      else if (/^[0-9a-f]{4,40}$/.test(base)) {
        const matches = (await gitText(repositoryRoot, ["rev-parse", `--disambiguate=${base}`])).split("\n").filter(Boolean);
        if (matches.length !== 1) throw new Error("Base commit abbreviation is unknown or ambiguous");
        commit = matches[0];
      } else commit = symbolic(base);
      if (commit === undefined) throw new Error("Base revision is not present in the pinned ref map");
      try { commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]); } catch { throw new Error("Base revision does not identify a commit"); }
      try { await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]); } catch { throw new Error("Base commit is not reachable from the pinned target"); }
      return commit;
    },
    async range(base: string) {
      const mergeBase = await gitText(repositoryRoot, ["merge-base", base, targetHead]);
      if (!mergeBase) throw new Error("Unable to derive merge-base for pinned range");
      const diffCommand = `git diff ${mergeBase}...${targetHead}`;
      const [{ stdout: diff }, commitsText] = await Promise.all([
        execFileAsync("git", ["-C", repositoryRoot, "diff", `${mergeBase}...${targetHead}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }),
        gitText(repositoryRoot, ["rev-list", "--reverse", `${mergeBase}..${targetHead}`]),
      ]);
      if (diff.length === 0) throw new Error("Pinned three-dot diff is empty");
      return Object.freeze({ base: mergeBase, target: targetHead, diffCommand, diffSha256: sha256Hex(Uint8Array.from(diff)), commits: Object.freeze(commitsText ? commitsText.split("\n") : []) });
    },
    async material(path: string, revision: string) {
      if (revision !== targetHead) throw new Error("Material revision is not the pinned target");
      const { stdout } = await execFileAsync("git", ["-C", repositoryRoot, "show", `${revision}:${path}`], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
      return Uint8Array.from(stdout);
    },
  });
}
