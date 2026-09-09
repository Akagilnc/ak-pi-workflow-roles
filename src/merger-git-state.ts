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
  /**
   * Read current merge materials.
   * Missing HEAD / MERGE_HEAD surface as empty strings; real Git infrastructure
   * and corruption failures still throw (ADR 0018 / 失败诚实 / #827).
   */
  activeMerge(): Promise<ActiveMergerGitState>;
}

type GitExecError = {
  code?: unknown;
  stderr?: unknown;
  message?: unknown;
};

function gitErrorText(error: unknown): string {
  const err = error as GitExecError;
  const stderr =
    typeof err.stderr === "string"
      ? err.stderr
      : err.stderr instanceof Uint8Array || Buffer.isBuffer(err.stderr)
        ? Buffer.from(err.stderr).toString("utf8")
        : "";
  const message = typeof err.message === "string" ? err.message : "";
  return `${stderr}\n${message}`;
}

/** True only when git itself reports the named revision is absent. */
function isMissingRevisionError(error: unknown): boolean {
  const err = error as GitExecError;
  // spawn / ENOENT / non-numeric failures are infrastructure — not "missing ref".
  if (typeof err.code === "string") return false;
  if (err.code !== 128) return false;
  const text = gitErrorText(error);
  // "not a git repository" is infrastructure, not an empty-material case.
  if (/not a git repository/i.test(text)) return false;
  return /needed a single revision|unknown revision|bad revision|ambiguous argument/i.test(
    text,
  );
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
      let targetObjectId = "";
      try {
        const head = line(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]), "Git HEAD");
        if (!isFullGitObjectId(head)) {
          throw new Error("Git HEAD identity is unavailable or invalid");
        }
        targetObjectId = head;
      } catch (error) {
        if (!isMissingRevisionError(error)) throw error;
        // Unborn / absent HEAD — empty target material.
      }

      let sourceObjectId = "";
      try {
        const mergeHeadRaw = await git(repositoryRoot, ["rev-parse", "--verify", "MERGE_HEAD"]);
        const mergeHeads = exactUtf8(mergeHeadRaw, "Git MERGE_HEAD")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
        if (mergeHeads.length === 0) {
          // Empty MERGE_HEAD content is corruption, not "no merge".
          throw new Error("Git MERGE_HEAD is empty");
        }
        if (mergeHeads.length !== 1) {
          throw new Error("Assigned repository does not have one ordinary in-progress merge");
        }
        const source = mergeHeads[0]!;
        if (!isFullGitObjectId(source)) {
          throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        }
        if (targetObjectId !== "" && source.length !== targetObjectId.length) {
          throw new Error("Git MERGE_HEAD identity is unavailable or invalid");
        }
        sourceObjectId = source;
      } catch (error) {
        if (!isMissingRevisionError(error)) throw error;
        // No MERGE_HEAD — empty source material.
      }

      // Index read failures (non-repo, IO, malformed rows) stay loud.
      const unmergedPaths = await unmerged(repositoryRoot);
      return { targetObjectId, sourceObjectId, unmergedPaths };
    },
  };
}
