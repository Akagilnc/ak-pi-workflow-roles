import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { exactUtf8 } from "./exact-utf8.ts";
import { isFullGitObjectId } from "./git-object-id.ts";

const execFileAsync = promisify(execFile);
export type ActiveMergerGitState = { targetObjectId: string; sourceObjectId: string; unmergedPaths: string[]; automaticMergeTreeId: string };
export type CompletedMergerGitState = { mergeCommitId: string; parentObjectIds: string[]; unmergedPaths: string[]; worktreeClean: boolean; resolutionChangedPaths: string[] };
export interface MergerGitState {
  activeMerge(): Promise<ActiveMergerGitState>;
  completedMerge(mergeCommitId: string, automaticMergeTreeId: string): Promise<CompletedMergerGitState>;
}

async function git(cwd: string, args: string[]): Promise<Uint8Array> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return new Uint8Array(stdout);
}
function line(bytes: Uint8Array, label: string): string {
  const value = exactUtf8(bytes, label).trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}
function nulPaths(bytes: Uint8Array, label: string): string[] {
  const raw = exactUtf8(bytes, label);
  if (raw.length > 0 && !raw.endsWith("\0")) throw new Error(`${label} is not NUL terminated`);
  return raw.split("\0").filter(Boolean).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
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

type ResidualSnapshot = readonly { status: string; paths: readonly { path: string; index: Uint8Array; mode: number; type: string; bytes: Uint8Array }[] }[];

async function residualSnapshot(cwd: string, activePaths: ReadonlySet<string>): Promise<ResidualSnapshot> {
  const raw = exactUtf8(await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), "Git worktree status");
  if (raw.length > 0 && !raw.endsWith("\0")) throw new Error("Git worktree status is not NUL terminated");
  const fields = raw.split("\0");
  const records: { status: string; names: string[] }[] = [];
  for (let cursor = 0; cursor < fields.length - 1;) {
    const field = fields[cursor++]!;
    if (field.length < 4 || field[2] !== " ") throw new Error("Git returned a malformed worktree status row");
    const names = [field.slice(3)];
    if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") names.push(fields[cursor++]!);
    if (!names.some(path => activePaths.has(path))) records.push({ status: field.slice(0, 2), names });
  }
  return Promise.all(records.map(async record => ({
    status: record.status,
    paths: await Promise.all(record.names.map(async path => {
      const index = await git(cwd, ["ls-files", "--stage", "-z", "--", path]);
      try {
        const stat = await lstat(resolve(cwd, path));
        const type = stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other";
        const bytes = stat.isFile() ? await readFile(resolve(cwd, path)) : stat.isSymbolicLink() ? Buffer.from(await readlink(resolve(cwd, path))) : new Uint8Array();
        return { path, index, mode: stat.mode, type, bytes: new Uint8Array(bytes) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { path, index, mode: 0, type: "missing", bytes: new Uint8Array() };
      }
    })),
  })));
}

function sameSnapshot(left: ResidualSnapshot, right: ResidualSnapshot): boolean {
  if (left.length !== right.length) return false;
  return left.every((record, index) => {
    const other = right[index];
    return other !== undefined && record.status === other.status && record.paths.length === other.paths.length && record.paths.every((path, pathIndex) => {
      const otherPath = other.paths[pathIndex];
      return otherPath !== undefined && path.path === otherPath.path && path.mode === otherPath.mode && path.type === otherPath.type && Buffer.from(path.index).equals(otherPath.index) && Buffer.from(path.bytes).equals(otherPath.bytes);
    });
  });
}

export function createProductionMergerGitState(repositoryRoot = process.cwd()): MergerGitState {
  let openingResidual: ResidualSnapshot | undefined;
  let frozenActivePaths: ReadonlySet<string> | undefined;
  return {
    async activeMerge() {
      const targetObjectId = line(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]), "Git HEAD");
      let mergeHeadRaw: Uint8Array;
      try {
        mergeHeadRaw = await git(repositoryRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
      } catch {
        throw new Error("Assigned repository does not have one ordinary in-progress merge");
      }
      const mergeHeads = exactUtf8(mergeHeadRaw, "Git MERGE_HEAD").trim().split(/\r?\n/).filter(Boolean);
      if (mergeHeads.length !== 1 || !isFullGitObjectId(targetObjectId) || !isFullGitObjectId(mergeHeads[0]) || targetObjectId.length !== mergeHeads[0]!.length) throw new Error("Assigned repository does not have one ordinary in-progress merge");
      let automaticMergeTreeRaw: Uint8Array;
      try {
        automaticMergeTreeRaw = await git(repositoryRoot, ["rev-parse", "--verify", "AUTO_MERGE^{tree}"]);
      } catch {
        throw new Error("Git automatic merge tree identity is unavailable or invalid");
      }
      const automaticMergeTreeId = line(automaticMergeTreeRaw, "Git automatic merge tree");
      if (!isFullGitObjectId(automaticMergeTreeId) || automaticMergeTreeId.length !== targetObjectId.length) throw new Error("Git automatic merge tree identity is unavailable or invalid");
      const unmergedPaths = await unmerged(repositoryRoot);
      if (openingResidual === undefined) {
        const automaticMergePaths = nulPaths(await git(repositoryRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", targetObjectId, automaticMergeTreeId]), "Git active merge path delta");
        frozenActivePaths = new Set([...automaticMergePaths, ...unmergedPaths]);
        openingResidual = await residualSnapshot(repositoryRoot, frozenActivePaths);
      }
      return { targetObjectId, sourceObjectId: mergeHeads[0]!, unmergedPaths, automaticMergeTreeId };
    },
    async completedMerge(mergeCommitId, automaticMergeTreeId) {
      if (!isFullGitObjectId(mergeCommitId) || !isFullGitObjectId(automaticMergeTreeId) || mergeCommitId.length !== automaticMergeTreeId.length) throw new Error("Merger completion object ID is invalid");
      const identity = exactUtf8(await git(repositoryRoot, ["show", "-s", "--format=%H%x00%P", mergeCommitId]), "Git merge commit").trimEnd().split("\0");
      if (identity.length !== 2 || identity[0] !== mergeCommitId) throw new Error("Git merge completion identity drifted");
      const parentObjectIds = identity[1]!.split(" ").filter(Boolean);
      const currentHead = line(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]), "Git HEAD");
      if (openingResidual === undefined || frozenActivePaths === undefined) throw new Error("Merger opening residual baseline was not captured");
      const closingResidual = await residualSnapshot(repositoryRoot, frozenActivePaths);
      const frozenTree = line(await git(repositoryRoot, ["rev-parse", "--verify", `${automaticMergeTreeId}^{tree}`]), "Git frozen automatic merge tree");
      if (frozenTree !== automaticMergeTreeId) throw new Error("Git frozen automatic merge tree identity drifted");
      const mergeTree = line(await git(repositoryRoot, ["rev-parse", "--verify", `${mergeCommitId}^{tree}`]), "Git completed merge tree");
      const resolutionChangedPaths = nulPaths(await git(repositoryRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", automaticMergeTreeId, mergeTree]), "Git resolution path delta");
      return { mergeCommitId: currentHead, parentObjectIds, unmergedPaths: await unmerged(repositoryRoot), worktreeClean: sameSnapshot(openingResidual, closingResidual) && currentHead === mergeCommitId, resolutionChangedPaths };
    },
  };
}
