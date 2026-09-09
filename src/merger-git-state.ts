import { execFile } from "node:child_process";
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
  /** Read current merge materials; never rejects for "no in-progress merge". */
  activeMerge(): Promise<ActiveMergerGitState>;
}

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

/**
 * Production Git materials seam for merger admission.
 * Absent MERGE_HEAD / parents / conflicts surface as empty strings and empty path sets —
 * the role decides escalate vs work; code does not gate attendance on merge state.
 */
export function createProductionMergerGitState(repositoryRoot = process.cwd()): MergerGitState {
  return {
    async activeMerge() {
      let targetObjectId = "";
      try {
        const head = line(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]), "Git HEAD");
        if (isFullGitObjectId(head)) targetObjectId = head;
      } catch {
        // No HEAD yet — leave empty material.
      }

      let sourceObjectId = "";
      try {
        const mergeHeadRaw = await git(repositoryRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
        const mergeHeads = exactUtf8(mergeHeadRaw, "Git MERGE_HEAD").trim().split(/\r?\n/).filter(Boolean);
        if (mergeHeads.length === 1 && isFullGitObjectId(mergeHeads[0]!) &&
            (targetObjectId === "" || mergeHeads[0]!.length === targetObjectId.length)) {
          sourceObjectId = mergeHeads[0]!;
        }
      } catch {
        // No in-progress merge — empty source material.
      }

      let unmergedPaths: string[] = [];
      try {
        unmergedPaths = await unmerged(repositoryRoot);
      } catch {
        unmergedPaths = [];
      }

      return { targetObjectId, sourceObjectId, unmergedPaths };
    },
  };
}
