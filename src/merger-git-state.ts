import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { exactUtf8 } from "./exact-utf8.ts";
import { isFullGitObjectId } from "./git-object-id.ts";

const execFileAsync = promisify(execFile);

/** Live Git materials for the merger assignment — empty fields mean absent facts. */
export type ActiveMergerGitState = {
  targetObjectId: string;
  sourceObjectId: string;
  unmergedPaths: string[];
};

export interface MergerGitState {
  /**
   * Read current merge materials.
   * Missing HEAD / MERGE_HEAD surface as empty strings; real Git infrastructure
   * and corruption failures still throw (ADR 0018 / 失败诚实 / #827).
   * Discrimination uses process exit codes and path existence — not stderr text.
   */
  activeMerge(): Promise<ActiveMergerGitState>;
}

type GitExecError = { code?: unknown };

async function git(cwd: string, args: string[]): Promise<Uint8Array> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return new Uint8Array(stdout);
}

function line(bytes: Uint8Array, label: string): string {
  const value = exactUtf8(bytes, label).trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm cwd is inside a usable Git work tree via structured exit status.
 * `rev-parse --is-inside-work-tree` exits 0 and prints the token `true` in-repo;
 * any other outcome is infrastructure failure (rethrown as-is).
 */
async function requireInsideWorkTree(cwd: string): Promise<void> {
  let stdout: Uint8Array;
  try {
    stdout = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    throw error;
  }
  if (exactUtf8(stdout, "Git worktree check").trim() !== "true") {
    throw new Error("Assigned path is not inside a Git work tree");
  }
}

/**
 * Resolve an optional commit-ish.
 * Exit 0 → full OID; exit 1 (git --quiet missing/invalid) → undefined;
 * any other exit/spawn failure rethrown.
 */
async function tryResolveCommit(cwd: string, rev: string): Promise<string | undefined> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
      cwd,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const code = (error as GitExecError).code;
    if (code === 1) return undefined;
    throw error;
  }
  const oid = line(await git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`]), `Git ${rev}`);
  if (!isFullGitObjectId(oid)) {
    throw new Error(`Git ${rev} identity is unavailable or invalid`);
  }
  return oid;
}

async function unmerged(cwd: string): Promise<string[]> {
  const raw = exactUtf8(await git(cwd, ["ls-files", "-u", "-z"]), "Git unmerged index");
  const paths = new Set<string>();
  for (const row of raw.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    if (tab < 0 || tab === row.length - 1) {
      throw new Error("Git returned a malformed unmerged index row");
    }
    paths.add(row.slice(tab + 1));
  }
  return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * Production Git materials seam for merger admission.
 * Absent HEAD/MERGE_HEAD become empty materials; unknown Git failures stay loud.
 */
export function createProductionMergerGitState(repositoryRoot = process.cwd()): MergerGitState {
  return {
    async activeMerge() {
      await requireInsideWorkTree(repositoryRoot);

      const targetObjectId = (await tryResolveCommit(repositoryRoot, "HEAD")) ?? "";

      // MERGE_HEAD presence is a path fact under the git dir — not stderr prose.
      const mergeHeadReported = line(
        await git(repositoryRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]),
        "Git MERGE_HEAD path",
      );
      const mergeHeadPath = isAbsolute(mergeHeadReported)
        ? mergeHeadReported
        : resolve(repositoryRoot, mergeHeadReported);
      let sourceObjectId = "";
      if (await pathExists(mergeHeadPath)) {
        const raw = exactUtf8(await readFile(mergeHeadPath), "Git MERGE_HEAD");
        const mergeHeads = raw
          .trim()
          .split(/\r?\n/)
          .map((row) => row.trim())
          .filter(Boolean);
        if (mergeHeads.length === 0) {
          throw new Error("Git MERGE_HEAD is empty");
        }
        if (mergeHeads.length !== 1) {
          throw new Error("Assigned repository does not have one ordinary in-progress merge");
        }
        const source = mergeHeads[0]!;
        if (!isFullGitObjectId(source)) {
          throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        }
        // Resolve through git so peeled/abbreviated forms and missing objects fail closed.
        const resolved = await tryResolveCommit(repositoryRoot, source);
        if (resolved === undefined) {
          throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        }
        if (targetObjectId !== "" && resolved.length !== targetObjectId.length) {
          throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        }
        sourceObjectId = resolved;
      }

      const unmergedPaths = await unmerged(repositoryRoot);
      return { targetObjectId, sourceObjectId, unmergedPaths };
    },
  };
}
