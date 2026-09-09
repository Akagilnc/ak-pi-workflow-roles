import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { exactUtf8 } from "./exact-utf8.ts";
import { isFullGitObjectId } from "./git-object-id.ts";

const execFileAsync = promisify(execFile);

export type ActiveMergerGitState = {
  targetObjectId: string;
  sourceObjectId: string;
  unmergedPaths: string[];
};

export interface MergerGitState {
  activeMerge(): Promise<ActiveMergerGitState>;
}

type GitExecError = { code?: unknown };

async function git(cwd: string, args: string[]): Promise<Uint8Array> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return new Uint8Array(stdout);
}

function line(bytes: Uint8Array, label: string): string {
  const value = exactUtf8(bytes, label).trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path, fsConstants.F_OK); return true; }
  catch (error) { if ((error as { code?: unknown }).code === "ENOENT") return false; throw error; }
}

async function requireInsideWorkTree(cwd: string): Promise<void> {
  const stdout = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (exactUtf8(stdout, "Git worktree check").trim() !== "true") throw new Error("Assigned path is not inside a Git work tree");
}

async function tryResolveCommit(cwd: string, rev: string): Promise<string | undefined> {
  let stdout: Uint8Array;
  try {
    const res = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    stdout = new Uint8Array(res.stdout);
  } catch (error) {
    if ((error as GitExecError).code === 1) return undefined;
    throw error;
  }
  const oid = line(stdout, `Git ${rev}`);
  if (!isFullGitObjectId(oid)) throw new Error(`Git ${rev} identity is unavailable or invalid`);
  return oid;
}

async function unmerged(cwd: string): Promise<string[]> {
  const raw = exactUtf8(await git(cwd, ["ls-files", "-u", "-z"]), "Git unmerged index");
  const paths = new Set<string>();
  for (const row of raw.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    if (tab < 0 || tab === row.length - 1) throw new Error("Git returned a malformed unmerged index row");
    paths.add(row.slice(tab + 1));
  }
  return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

async function resolveHeadMaterial(cwd: string): Promise<string> {
  const commit = await tryResolveCommit(cwd, "HEAD");
  if (commit !== undefined) return commit;
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if ((error as GitExecError).code === 1) return "";
    throw error;
  }
  throw new Error("Git HEAD identity is unavailable or invalid");
}

export function createProductionMergerGitState(repositoryRoot = process.cwd()): MergerGitState {
  return {
    async activeMerge() {
      await requireInsideWorkTree(repositoryRoot);
      const targetObjectId = await resolveHeadMaterial(repositoryRoot);
      const mergeHeadReported = line(await git(repositoryRoot, ["rev-parse", "--git-path", "MERGE_HEAD"]), "Git MERGE_HEAD path");
      const mergeHeadPath = isAbsolute(mergeHeadReported) ? mergeHeadReported : resolve(repositoryRoot, mergeHeadReported);
      let sourceObjectId = "";
      if (await pathExists(mergeHeadPath)) {
        const raw = exactUtf8(await readFile(mergeHeadPath), "Git MERGE_HEAD");
        const mergeHeads = raw.trim().split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
        if (mergeHeads.length === 0) throw new Error("Git MERGE_HEAD is empty");
        if (mergeHeads.length !== 1) throw new Error("Assigned repository does not have one ordinary in-progress merge");
        const source = mergeHeads[0]!;
        if (!isFullGitObjectId(source)) throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        const resolved = await tryResolveCommit(repositoryRoot, source);
        if (resolved === undefined || (targetObjectId !== "" && resolved.length !== targetObjectId.length)) {
          throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        }
        sourceObjectId = resolved;
      }
      return { targetObjectId, sourceObjectId, unmergedPaths: await unmerged(repositoryRoot) };
    },
  };
}
