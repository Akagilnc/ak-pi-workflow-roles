import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { RecorderError } from "./errors.ts";

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_IDS = new Set([
  "receipt",
  "audit-observation",
  "manifest",
  "redaction-report",
]);
const RESERVED_PATH_PREFIXES = [
  "receipt.json",
  "audit-observation.json",
  "manifest.json",
  "redaction-report.json",
];

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
  } catch {
    throw new RecorderError(
      "invalid-path",
      `${label} must resolve to an existing path`,
    );
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new RecorderError(
      "invalid-path",
      `${label} must resolve to an existing directory`,
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
  } catch {
    throw new RecorderError(
      "invalid-archive",
      `${label} must be a Git worktree`,
    );
  }
  let topReal: string;
  try {
    topReal = realpathSync(toplevel);
  } catch {
    throw new RecorderError(
      "invalid-archive",
      `${label} toplevel is unreadable`,
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

export function assertPathNotSymlinkEscape(
  absolutePath: string,
  rootReal: string,
  label: string,
): void {
  try {
    if (existsSync(absolutePath)) {
      const st = lstatSync(absolutePath);
      if (st.isSymbolicLink()) {
        const real = realpathSync(absolutePath);
        const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
        if (real !== rootReal && !real.startsWith(rootWithSep)) {
          throw new RecorderError(
            "invalid-path",
            `${label} escapes the selected worktree via symlink`,
          );
        }
      }
    }
    const real = existsSync(absolutePath)
      ? realpathSync(absolutePath)
      : null;
    if (real) {
      const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
      if (real !== rootReal && !real.startsWith(rootWithSep)) {
        throw new RecorderError(
          "invalid-path",
          `${label} escapes the selected worktree via symlink`,
        );
      }
      return;
    }
  } catch (error) {
    if (error instanceof RecorderError) throw error;
  }
  // path may not exist yet; validate existing parents
  let parent = resolve(absolutePath, "..");
  while (true) {
    try {
      if (existsSync(parent)) {
        const realParent = realpathSync(parent);
        const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
        if (realParent !== rootReal && !realParent.startsWith(rootWithSep)) {
          throw new RecorderError(
            "invalid-path",
            `${label} escapes the selected worktree via symlink`,
          );
        }
        return;
      }
    } catch (inner) {
      if (inner instanceof RecorderError) throw inner;
    }
    const next = resolve(parent, "..");
    if (next === parent) return;
    parent = next;
  }
}

export function assertNotReservedArtifactId(id: string, label: string): void {
  if (RESERVED_IDS.has(id)) {
    throw new RecorderError(
      "invalid-config",
      `${label} uses a reserved generated id`,
    );
  }
}

export function assertNotReservedStoredPath(
  relativePath: string,
  label: string,
): void {
  if (
    RESERVED_PATH_PREFIXES.some(
      (prefix) =>
        relativePath === prefix || relativePath.startsWith(`${prefix}/`),
    )
  ) {
    throw new RecorderError(
      "invalid-config",
      `${label} uses a reserved generated path`,
    );
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
  } catch {
    scratchReal = resolve(scratchPath);
  }
  if (scratchReal !== worktreeRoot && !scratchReal.startsWith(rootWithSep)) {
    return; // outside — fine
  }
  // Inside worktree: must be ignored
  try {
    const check = execFileSync(
      "git",
      ["-C", worktreeRoot, "check-ignore", "-q", scratchReal],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    void check;
  } catch {
    throw new RecorderError(
      "invalid-path",
      "scratch/stage inside worktree must be gitignored",
    );
  }
}
