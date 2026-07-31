import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { RecorderError, safeDiagnostic } from "./errors.ts";

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function requireAbsoluteExistingDirectory(
  value: string,
  label: string,
): string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new RecorderError(
      "invalid-path",
      `${label} must be an absolute path`,
    );
  }
  let real: string;
  try {
    real = realpathSync(value);
  } catch (error) {
    throw new RecorderError(
      "invalid-path",
      `${label} must resolve to an existing path`,
      { cause: error },
    );
  }
  let st;
  try {
    st = statSync(real);
  } catch (error) {
    throw new RecorderError(
      "invalid-path",
      `${label} must resolve to an existing directory`,
      { cause: error },
    );
  }
  if (!st.isDirectory()) {
    throw new RecorderError(
      "invalid-path",
      `${label} must resolve to a directory`,
    );
  }
  return real;
}

/**
 * Resolve a path through Git's canonical worktree identity.
 * Requires exact equality with rev-parse --show-toplevel.
 */
export function requireCanonicalGitWorktree(
  value: string,
  label: string,
): string {
  const real = requireAbsoluteExistingDirectory(value, label);
  // Reject bare .git administrative destinations and non-worktrees.
  const base = real.split(sep).pop() ?? "";
  if (base === ".git") {
    throw new RecorderError(
      "invalid-archive",
      `${label} must not be a Git administrative path`,
    );
  }
  let toplevel: string;
  try {
    toplevel = execFileSync(
      "git",
      ["-C", real, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    throw new RecorderError(
      "invalid-archive",
      `${label} must be a Git worktree`,
      { cause: error },
    );
  }
  let topReal: string;
  try {
    topReal = realpathSync(toplevel);
  } catch (error) {
    throw new RecorderError(
      "invalid-archive",
      `${label} toplevel is unreadable`,
      { cause: error },
    );
  }
  if (topReal !== real) {
    throw new RecorderError(
      "invalid-archive",
      `${label} must equal Git canonical worktree root`,
    );
  }
  // Ensure it is not inside a .git directory via realpath of .git
  try {
    const gitPath = execFileSync(
      "git",
      ["-C", real, "rev-parse", "--git-dir"],
      { encoding: "utf8" },
    ).trim();
    const gitAbs = isAbsolute(gitPath) ? gitPath : resolve(real, gitPath);
    const gitReal = realpathSync(gitAbs);
    if (real === gitReal || real.startsWith(gitReal + sep)) {
      throw new RecorderError(
        "invalid-archive",
        `${label} must not be a Git administrative path`,
      );
    }
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    throw new RecorderError(
      "invalid-archive",
      `${label} must be a Git worktree`,
      { cause: error },
    );
  }
  return real;
}

export function normalizeRepoRelativePath(
  value: string,
  label: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecorderError("invalid-path", `${label} must be a non-empty path`);
  }
  if (isAbsolute(value) || value.includes("\\")) {
    throw new RecorderError(
      "invalid-path",
      `${label} must be a repository-relative slash path`,
    );
  }
  if (value.includes("\0")) {
    throw new RecorderError("invalid-path", `${label} contains a NUL byte`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new RecorderError(
      "invalid-path",
      `${label} must not contain empty segments`,
    );
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new RecorderError(
        "invalid-path",
        `${label} must not contain . or .. segments`,
      );
    }
    if (segment === ".git") {
      throw new RecorderError(
        "invalid-path",
        `${label} must not target Git administrative paths`,
      );
    }
    if (segment === ".ak") continue;
    if (!SEGMENT_RE.test(segment)) {
      throw new RecorderError(
        "invalid-path",
        `${label} contains an unlawful path segment`,
      );
    }
  }
  return segments.join("/");
}

export function resolveInsideRoot(
  rootReal: string,
  relativePath: string,
  label: string,
): string {
  const candidate = resolve(rootReal, relativePath);
  const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (candidate !== rootReal && !candidate.startsWith(rootWithSep)) {
    throw new RecorderError(
      "invalid-path",
      `${label} escapes the selected worktree`,
    );
  }
  return candidate;
}

function assertRealInsideRoot(
  real: string,
  rootReal: string,
  label: string,
): void {
  const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (real !== rootReal && !real.startsWith(rootWithSep)) {
    throw new RecorderError(
      "invalid-path",
      `${label} escapes the selected worktree via symlink`,
    );
  }
}

export function assertPathNotSymlinkEscape(
  absolutePath: string,
  rootReal: string,
  label: string,
): void {
  // Prove leaf existence or absence; unexpected failures fail closed.
  let leafExists = false;
  try {
    const st = lstatSync(absolutePath);
    leafExists = true;
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(absolutePath);
      } catch (error) {
        if (isEnoent(error)) {
          // Dangling symlink race → treat as absence and walk parents.
          leafExists = false;
        } else {
          throw new RecorderError("invalid-path", `${label} is unreadable`, {
            cause: error,
            diagnostic: safeDiagnostic("destination", error),
          });
        }
      }
      if (leafExists) {
        assertRealInsideRoot(real!, rootReal, label);
        return;
      }
    } else {
      let real: string;
      try {
        real = realpathSync(absolutePath);
      } catch (error) {
        if (isEnoent(error)) {
          leafExists = false;
        } else {
          throw new RecorderError("invalid-path", `${label} is unreadable`, {
            cause: error,
            diagnostic: safeDiagnostic("destination", error),
          });
        }
      }
      if (leafExists) {
        assertRealInsideRoot(real!, rootReal, label);
        return;
      }
    }
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    if (!isEnoent(error)) {
      throw new RecorderError("invalid-path", `${label} is unreadable`, {
        cause: error,
        diagnostic: safeDiagnostic("destination", error),
      });
    }
  }

  // Path absent: validate the nearest existing parent via realpath only.
  let parent = resolve(absolutePath, "..");
  while (true) {
    try {
      const realParent = realpathSync(parent);
      assertRealInsideRoot(realParent, rootReal, label);
      return;
    } catch (error) {
      if (error instanceof RecorderError) throw error;
      if (!isEnoent(error)) {
        throw new RecorderError("invalid-path", `${label} is unreadable`, {
          cause: error,
          diagnostic: safeDiagnostic("destination", error),
        });
      }
    }
    const next = resolve(parent, "..");
    if (next === parent) {
      // No existing parent could be proved — fail closed rather than continue.
      throw new RecorderError(
        "invalid-path",
        `${label} has no resolvable parent`,
      );
    }
    parent = next;
  }
}

/**
 * Place scratch/stage outside the selected worktree, or prove the location is
 * ignored by that worktree before spawn.
 */
export function assertScratchOutsideOrIgnored(
  scratchPath: string,
  worktreeRoot: string,
): void {
  const rootWithSep = worktreeRoot.endsWith(sep)
    ? worktreeRoot
    : worktreeRoot + sep;
  let scratchReal: string;
  try {
    scratchReal = realpathSync(scratchPath);
  } catch (error) {
    if (isEnoent(error)) {
      // Absence only: resolve lexically for the outside-worktree check.
      scratchReal = resolve(scratchPath);
    } else {
      throw new RecorderError("invalid-path", "scratch path is unreadable", {
        cause: error,
        diagnostic: safeDiagnostic("stage-allocation", error),
      });
    }
  }
  if (scratchReal !== worktreeRoot && !scratchReal.startsWith(rootWithSep)) {
    return; // outside — fine
  }
  // Inside worktree: must be ignored. Only exit 1 is the documented not-ignored negative.
  try {
    execFileSync(
      "git",
      ["-C", worktreeRoot, "check-ignore", "-q", scratchReal],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
    // git check-ignore -q: exit 0 = ignored, exit 1 = not ignored.
    if (status === 1) {
      throw new RecorderError(
        "invalid-path",
        "scratch/stage inside worktree must be gitignored",
      );
    }
    throw new RecorderError(
      "invalid-path",
      "scratch/stage gitignore check failed",
      {
        cause: error,
        diagnostic: safeDiagnostic("stage-allocation", error),
      },
    );
  }
}

/** Require two existing paths share one device (same filesystem). */
export function assertSameFilesystem(
  leftPath: string,
  rightPath: string,
  label: string,
): void {
  let leftStat;
  let rightStat;
  try {
    leftStat = statSync(leftPath);
    rightStat = statSync(rightPath);
  } catch (error) {
    throw new RecorderError("invalid-path", `${label} is unreadable`, {
      cause: error,
    });
  }
  if (leftStat.dev !== rightStat.dev) {
    throw new RecorderError(
      "invalid-path",
      `${label} must be on the same filesystem`,
    );
  }
}

/**
 * Private publication stage under the archive worktree's ignored `.ak/work`
 * area so rename promotion stays same-filesystem with the final docket parent.
 */
export function allocateIgnoredStageRoot(worktreeRoot: string): string {
  const workRoot = resolveInsideRoot(
    worktreeRoot,
    ".ak/work",
    "archive private work area",
  );
  mkdirSync(workRoot, { recursive: true });
  assertPathNotSymlinkEscape(workRoot, worktreeRoot, "archive private work area");
  const stage = mkdtempSync(join(workRoot, "recorder-stage-"));
  assertPathNotSymlinkEscape(stage, worktreeRoot, "publication stage");
  assertScratchOutsideOrIgnored(stage, worktreeRoot);
  assertSameFilesystem(stage, worktreeRoot, "publication stage");
  return stage;
}
