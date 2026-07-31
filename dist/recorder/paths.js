import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { RecorderError } from "./errors.js";
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function requireAbsoluteExistingDirectory(value, label) {
    if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
        throw new RecorderError("invalid-path", `${label} must be an absolute path`);
    }
    let real;
    try {
        real = realpathSync(value);
    }
    catch (error) {
        throw new RecorderError("invalid-path", `${label} must resolve to an existing path`, { cause: error });
    }
    let st;
    try {
        st = statSync(real);
    }
    catch (error) {
        throw new RecorderError("invalid-path", `${label} must resolve to an existing directory`, { cause: error });
    }
    if (!st.isDirectory()) {
        throw new RecorderError("invalid-path", `${label} must resolve to a directory`);
    }
    return real;
}
/**
 * Resolve a path through Git's canonical worktree identity.
 * Requires exact equality with rev-parse --show-toplevel.
 */
export function requireCanonicalGitWorktree(value, label) {
    const real = requireAbsoluteExistingDirectory(value, label);
    // Reject bare .git administrative destinations and non-worktrees.
    const base = real.split(sep).pop() ?? "";
    if (base === ".git") {
        throw new RecorderError("invalid-archive", `${label} must not be a Git administrative path`);
    }
    let toplevel;
    try {
        toplevel = execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    }
    catch (error) {
        throw new RecorderError("invalid-archive", `${label} must be a Git worktree`, { cause: error });
    }
    let topReal;
    try {
        topReal = realpathSync(toplevel);
    }
    catch (error) {
        throw new RecorderError("invalid-archive", `${label} toplevel is unreadable`, { cause: error });
    }
    if (topReal !== real) {
        throw new RecorderError("invalid-archive", `${label} must equal Git canonical worktree root`);
    }
    // Ensure it is not inside a .git directory via realpath of .git
    try {
        const gitPath = execFileSync("git", ["-C", real, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
        const gitAbs = isAbsolute(gitPath) ? gitPath : resolve(real, gitPath);
        const gitReal = realpathSync(gitAbs);
        if (real === gitReal || real.startsWith(gitReal + sep)) {
            throw new RecorderError("invalid-archive", `${label} must not be a Git administrative path`);
        }
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
        throw new RecorderError("invalid-archive", `${label} must be a Git worktree`, { cause: error });
    }
    return real;
}
export function normalizeRepoRelativePath(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new RecorderError("invalid-path", `${label} must be a non-empty path`);
    }
    if (isAbsolute(value) || value.includes("\\")) {
        throw new RecorderError("invalid-path", `${label} must be a repository-relative slash path`);
    }
    if (value.includes("\0")) {
        throw new RecorderError("invalid-path", `${label} contains a NUL byte`);
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0)) {
        throw new RecorderError("invalid-path", `${label} must not contain empty segments`);
    }
    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new RecorderError("invalid-path", `${label} must not contain . or .. segments`);
        }
        if (segment === ".git") {
            throw new RecorderError("invalid-path", `${label} must not target Git administrative paths`);
        }
        if (segment === ".ak")
            continue;
        if (!SEGMENT_RE.test(segment)) {
            throw new RecorderError("invalid-path", `${label} contains an unlawful path segment`);
        }
    }
    return segments.join("/");
}
export function resolveInsideRoot(rootReal, relativePath, label) {
    const candidate = resolve(rootReal, relativePath);
    const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (candidate !== rootReal && !candidate.startsWith(rootWithSep)) {
        throw new RecorderError("invalid-path", `${label} escapes the selected worktree`);
    }
    return candidate;
}
export function assertPathNotSymlinkEscape(absolutePath, rootReal, label) {
    try {
        if (existsSync(absolutePath)) {
            const st = lstatSync(absolutePath);
            if (st.isSymbolicLink()) {
                const real = realpathSync(absolutePath);
                const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
                if (real !== rootReal && !real.startsWith(rootWithSep)) {
                    throw new RecorderError("invalid-path", `${label} escapes the selected worktree via symlink`);
                }
            }
        }
        const real = existsSync(absolutePath)
            ? realpathSync(absolutePath)
            : null;
        if (real) {
            const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
            if (real !== rootReal && !real.startsWith(rootWithSep)) {
                throw new RecorderError("invalid-path", `${label} escapes the selected worktree via symlink`);
            }
            return;
        }
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
    }
    // path may not exist yet; validate existing parents
    let parent = resolve(absolutePath, "..");
    while (true) {
        try {
            if (existsSync(parent)) {
                const realParent = realpathSync(parent);
                const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
                if (realParent !== rootReal && !realParent.startsWith(rootWithSep)) {
                    throw new RecorderError("invalid-path", `${label} escapes the selected worktree via symlink`);
                }
                return;
            }
        }
        catch (inner) {
            if (inner instanceof RecorderError)
                throw inner;
        }
        const next = resolve(parent, "..");
        if (next === parent)
            return;
        parent = next;
    }
}
/**
 * Place scratch/stage outside the selected worktree, or prove the location is
 * ignored by that worktree before spawn.
 */
export function assertScratchOutsideOrIgnored(scratchPath, worktreeRoot) {
    const rootWithSep = worktreeRoot.endsWith(sep)
        ? worktreeRoot
        : worktreeRoot + sep;
    let scratchReal;
    try {
        scratchReal = realpathSync(scratchPath);
    }
    catch {
        scratchReal = resolve(scratchPath);
    }
    if (scratchReal !== worktreeRoot && !scratchReal.startsWith(rootWithSep)) {
        return; // outside — fine
    }
    // Inside worktree: must be ignored
    try {
        const check = execFileSync("git", ["-C", worktreeRoot, "check-ignore", "-q", scratchReal], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        void check;
    }
    catch {
        throw new RecorderError("invalid-path", "scratch/stage inside worktree must be gitignored");
    }
}
/** Require two existing paths share one device (same filesystem). */
export function assertSameFilesystem(leftPath, rightPath, label) {
    let leftStat;
    let rightStat;
    try {
        leftStat = statSync(leftPath);
        rightStat = statSync(rightPath);
    }
    catch (error) {
        throw new RecorderError("invalid-path", `${label} is unreadable`, {
            cause: error,
        });
    }
    if (leftStat.dev !== rightStat.dev) {
        throw new RecorderError("invalid-path", `${label} must be on the same filesystem`);
    }
}
/**
 * Private publication stage under the archive worktree's ignored `.ak/work`
 * area so rename promotion stays same-filesystem with the final docket parent.
 */
export function allocateIgnoredStageRoot(worktreeRoot) {
    const workRoot = resolveInsideRoot(worktreeRoot, ".ak/work", "archive private work area");
    mkdirSync(workRoot, { recursive: true });
    assertPathNotSymlinkEscape(workRoot, worktreeRoot, "archive private work area");
    const stage = mkdtempSync(join(workRoot, "recorder-stage-"));
    assertPathNotSymlinkEscape(stage, worktreeRoot, "publication stage");
    assertScratchOutsideOrIgnored(stage, worktreeRoot);
    assertSameFilesystem(stage, worktreeRoot, "publication stage");
    return stage;
}
