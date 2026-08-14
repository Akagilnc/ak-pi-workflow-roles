import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { immutableReviewerRefs, parseReviewerRefSnapshot, reviewerRefSnapshotArgs } from "./reviewer-git-snapshot.js";
import { sha256Hex } from "./sha256.js";
import { ReviewerCorrectablePreflightError } from "./reviewer-preflight-error.js";
const execFileAsync = promisify(execFile);
async function execGit(args, options) {
  try {
    return await execFileAsync("git", args, options);
  } catch (error) {
    const source = error;
    const wrapped = new Error("git process failed", { cause: error });
    Object.assign(wrapped, { code: source.code ?? null, signal: source.signal ?? null, timedOut: source.killed === true && source.signal === "SIGTERM", aborted: source.name === "AbortError", stderr: String(source.stderr ?? ""), stdout: String(source.stdout ?? "") });
    throw wrapped;
  }
}
function exitCode(error) {
  const code = typeof error === "object" && error !== null ? error.code : void 0;
  return typeof code === "number" ? code : void 0;
}
function gitStderr(error) {
  if (typeof error !== "object" || error === null) return "";
  const stderr = error.stderr;
  return typeof stderr === "string" ? stderr : "";
}
function isConfirmedMissingOriginRemote(error) {
  return /No such remote ['"]origin['"]/.test(gitStderr(error));
}
function isConfirmedPinnedPathAbsent(error, path) {
  const stderr = gitStderr(error);
  const quoted = `'${path}'`;
  return stderr.includes(`path ${quoted} does not exist in `) || stderr.includes(`path ${quoted} exists on disk, but not in `);
}
async function repositoryIsAvailable(root) {
  try {
    await access(`${root}/.git`);
    return { available: true };
  } catch (cause) {
    return { available: false, cause };
  }
}
const immutableReviewerPin = (pin) => Object.freeze({
  repositoryRoot: pin.repositoryRoot,
  objectFormat: pin.objectFormat,
  targetHead: pin.targetHead,
  refs: immutableReviewerRefs(pin.refs)
});
async function gitText(root, args) {
  const { stdout } = await execGit(["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}
async function createReviewerPinnedGitReader(root = process.cwd()) {
  const discoveredRoot = await gitText(root, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(discoveredRoot);
  const objectFormat = await gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format");
  const oidWidth = objectFormat === "sha1" ? 40 : 64;
  const targetHead = await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]);
  const reachableCommitIds = Object.freeze((await gitText(repositoryRoot, ["rev-list", targetHead])).split("\n").filter(Boolean));
  const refs = parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs()));
  const pin = immutableReviewerPin({ repositoryRoot, objectFormat, targetHead, refs });
  const invalid = (code, diagnostic, cause) => {
    throw new ReviewerCorrectablePreflightError(code, diagnostic, cause === void 0 ? void 0 : { cause });
  };
  const symbolic = (base) => {
    const selected = Object.hasOwn(refs, base) ? base : (() => {
      const candidates = [`refs/heads/${base}`, `refs/tags/${base}`, `refs/remotes/${base}`].filter((name) => Object.hasOwn(refs, name));
      if (candidates.length > 1) invalid("base-invalid", "base revision is ambiguous across pinned refs");
      return candidates[0];
    })();
    if (selected === void 0) return void 0;
    const commit = refs[selected]?.peeledCommitId;
    if (commit === null) invalid("base-invalid", "base revision ref must resolve to a commit");
    return commit ?? void 0;
  };
  return Object.freeze({
    pin,
    async snapshot() {
      const liveObjectFormat = await gitText(repositoryRoot, ["rev-parse", "--show-object-format"]);
      if (liveObjectFormat !== "sha1" && liveObjectFormat !== "sha256") throw new Error("Unsupported Git object format");
      return immutableReviewerPin({ repositoryRoot, objectFormat: liveObjectFormat, targetHead: await gitText(repositoryRoot, ["rev-parse", "HEAD^{commit}"]), refs: parseReviewerRefSnapshot(await gitText(repositoryRoot, reviewerRefSnapshotArgs())) });
    },
    async resolve(base) {
      if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) || base.startsWith("-") || base.includes("..") || base.includes("@{")) {
        invalid("base-invalid", "base revision syntax is invalid or uses a forbidden revision form");
      }
      let commit;
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
      if (commit === void 0) invalid("base-invalid", "base revision must name an existing pinned ref or reachable commit");
      try {
        commit = await gitText(repositoryRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
      } catch (error) {
        if (exitCode(error) === 128) {
          const repository = await repositoryIsAvailable(repositoryRoot);
          if (repository.available) invalid("base-invalid", "base revision must resolve to an existing commit", error);
        }
        throw error;
      }
      try {
        await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]);
      } catch (error) {
        if (exitCode(error) === 1) invalid("base-invalid", "base revision must be an ancestor of the pinned target", error);
        throw error;
      }
      return commit;
    },
    async range(base) {
      let mergeBase;
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
        gitText(repositoryRoot, ["rev-list", "--reverse", `${mergeBase}..${targetHead}`])
      ]);
      if (diff.length === 0) invalid("range-invalid", "review range must contain a non-empty diff between base and pinned target");
      return Object.freeze({ base: mergeBase, target: targetHead, diffCommand, diffSha256: sha256Hex(Uint8Array.from(diff)), commits: Object.freeze(commitsText ? commitsText.split("\n") : []) });
    },
    async featureTokens() {
      const names = /* @__PURE__ */ new Set();
      for (const [refName, entry] of Object.entries(pin.refs)) {
        if (entry.peeledCommitId !== targetHead) continue;
        const short = refName.startsWith("refs/heads/") ? refName.slice("refs/heads/".length) : refName.startsWith("refs/tags/") ? refName.slice("refs/tags/".length) : refName.startsWith("refs/remotes/") ? refName.slice("refs/remotes/".length).replace(/^[^/]+\//, "") : refName;
        if (short.trim() !== "") names.add(short.trim());
      }
      return Object.freeze([...names]);
    },
    async listSpecCandidatePaths() {
      const roots = ["docs", "specs", ".scratch"];
      const text = await gitText(repositoryRoot, [
        "ls-tree",
        "-r",
        "--name-only",
        targetHead,
        "--",
        ...roots
      ]);
      return Object.freeze(text === "" ? [] : text.split("\n").filter((line) => line.length > 0));
    },
    async originRepository() {
      let remoteUrl;
      try {
        remoteUrl = await gitText(repositoryRoot, ["remote", "get-url", "origin"]);
      } catch (error) {
        if (isConfirmedMissingOriginRemote(error)) return void 0;
        throw error;
      }
      return parseGitHubOriginRemote(remoteUrl);
    },
    async commitMessagesNewestFirst(base) {
      const text = await gitText(repositoryRoot, [
        "log",
        "--format=%s",
        `${base}..${targetHead}`
      ]);
      return Object.freeze(text === "" ? [] : text.split("\n"));
    },
    async readPinnedText(path) {
      if (path.length === 0 || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === "")) {
        return void 0;
      }
      try {
        const { stdout } = await execGit(
          ["-C", repositoryRoot, "show", `${targetHead}:${path}`],
          { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
        );
        return stdout;
      } catch (error) {
        if (isConfirmedPinnedPathAbsent(error, path)) return void 0;
        throw error;
      }
    }
  });
}
function parseGitHubOriginRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return void 0;
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) return normalizeOrigin(scp[1], scp[2]);
  const ssh = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh) return normalizeOrigin(ssh[1], ssh[2]);
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return void 0;
  }
  if (!/^github\.com$/i.test(parsed.hostname)) return void 0;
  if (parsed.search !== "" || parsed.hash !== "") return void 0;
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return void 0;
  return normalizeOrigin(parts[0], parts[1]);
}
function normalizeOrigin(ownerRaw, repoRaw) {
  const owner = ownerRaw.trim();
  const repo = stripGitSuffix(repoRaw.trim());
  if (owner.length === 0 || repo.length === 0) return void 0;
  if (/[/?#@\\]/.test(owner) || /[/?#@\\]/.test(repo)) return void 0;
  return Object.freeze({ owner, repo });
}
function stripGitSuffix(name) {
  return name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
}
export {
  createReviewerPinnedGitReader,
  immutableReviewerPin,
  parseGitHubOriginRemote
};
