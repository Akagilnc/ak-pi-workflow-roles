import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sameReviewerPinnedTarget } from "./reviewer-git-snapshot.ts";
import type { ReviewerTargetSnapshot, ReviewerWorkspaceDisposition } from "./reviewer-execution-ledger.ts";

export type ReviewerWorkspaceFaultPoint =
  | "snapshot.head"
  | "mirror.before-create" | "mirror.create" | "mirror.verify"
  | "workspace.before-create" | "workspace.init" | "workspace.fetch" | "workspace.verify";
export type ReviewerWorkspaceDependencies = Readonly<{ fault?(operation: ReviewerWorkspaceFaultPoint): void }>;
export type ReviewerWorkspaceError = Error & Readonly<{ reviewerFailure: "snapshot" | "workspace"; workspaceDisposition: ReviewerWorkspaceDisposition; targetSnapshot: ReviewerTargetSnapshot; preparedWorkspaces?: readonly ReviewerPreparedWorkspace[] }>;
export type ReviewerPreparedWorkspace = Readonly<{ axis: "standards" | "spec"; path: string; target: ReviewerTargetSnapshot }>;
export type ReviewerWorkspaceBatch = Readonly<{ target: ReviewerTargetSnapshot; workspaces: readonly ReviewerPreparedWorkspace[] }>;
export type ReviewerWorkspaceOwner = {
  prepare(target: ReviewerTargetSnapshot, axes: readonly ("standards" | "spec")[], signal?: AbortSignal): Promise<ReviewerWorkspaceBatch>;
  dispose(workspace: ReviewerPreparedWorkspace): Promise<"deleted">;
  shutdown(): Promise<void>;
};
type GitSnapshot = ReviewerTargetSnapshot & { mirrorRoot: string; mirrorPath: string };
type CommandResult = { stdout: string; stderr: string; code: number };
export class ReviewerProcessError extends Error {
  constructor(readonly command: string, readonly args: readonly string[], readonly code: number | null, readonly signal: NodeJS.Signals | null, readonly timedOut: boolean, readonly aborted: boolean, readonly stderr: string, readonly stdout: string, cause?: unknown) {
    super(`${command} ${args.join(" ")} failed`, { cause });
    this.name = "ReviewerProcessError";
  }
}
async function runCommand(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; allowedCodes?: readonly number[] } = {}): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    let settled = false;
    const fail = (error: unknown, code: number | null, signal: NodeJS.Signals | null) => { if (settled) return; settled = true; reject(new ReviewerProcessError(command, args, code, signal, false, options.signal?.aborted === true, stderr, stdout, error)); };
    child.on("error", error => fail(error, null, null));
    child.on("close", (code, signal) => { const actual = code ?? 1; if ((options.allowedCodes ?? [0]).includes(actual)) { settled = true; resolve({ stdout, stderr, code: actual }); } else fail(undefined, code, signal); });
  });
}
async function git(cwd: string, args: string[], signal?: AbortSignal, allowedCodes?: readonly number[]) { return runCommand("git", ["-C", cwd, ...args], { ...(signal === undefined ? {} : { signal }), ...(allowedCodes === undefined ? {} : { allowedCodes }) }); }
async function verifySnapshot(cwd: string, snapshot: ReviewerTargetSnapshot, signal?: AbortSignal) {
  if ((await git(cwd, ["rev-parse", "--show-object-format"], signal)).stdout.trim() !== snapshot.objectFormat) throw new Error("Review clone object format does not match the pinned session snapshot");
  const head = (await git(cwd, ["rev-parse", "HEAD^{commit}"], signal)).stdout.trim();
  if (head !== snapshot.targetHead) throw new Error(`Review clone target mismatch: expected ${snapshot.targetHead}, got ${head}`);
  await git(cwd, ["cat-file", "-e", `${snapshot.targetHead}^{commit}`], signal);
}
function workspaceError(error: unknown, failure: "snapshot" | "workspace", disposition: ReviewerWorkspaceDisposition, target: ReviewerTargetSnapshot): ReviewerWorkspaceError {
  const wrapped = error instanceof Error ? error : new Error(String(error), { cause: error });
  return Object.assign(wrapped, { reviewerFailure: failure, workspaceDisposition: disposition, targetSnapshot: target });
}
async function prepareSnapshot(accepted: ReviewerTargetSnapshot, signal: AbortSignal | undefined, dependencies: ReviewerWorkspaceDependencies): Promise<GitSnapshot> {
  let mirrorRoot: string | undefined;
  try {
    dependencies.fault?.("snapshot.head");
    const objectFormat = (await git(accepted.repositoryRoot, ["rev-parse", "--show-object-format"], signal)).stdout.trim();
    const targetHead = (await git(accepted.repositoryRoot, ["rev-parse", "HEAD^{commit}"], signal)).stdout.trim();
    if (!sameReviewerPinnedTarget({ repositoryRoot: accepted.repositoryRoot, objectFormat: objectFormat as "sha1" | "sha256", targetHead }, accepted)) throw new Error("Accepted Reviewer target identity no longer matches the repository");
    await git(accepted.repositoryRoot, ["cat-file", "-e", `${targetHead}^{commit}`], signal);
    dependencies.fault?.("mirror.before-create"); mirrorRoot = await mkdtemp(join(tmpdir(), "ak-reviewer-snapshot-")); const mirrorPath = join(mirrorRoot, "repository.git");
    dependencies.fault?.("mirror.create"); await runCommand("git", ["init", "--bare", `--object-format=${accepted.objectFormat}`, mirrorPath], signal === undefined ? {} : { signal });
    await git(mirrorPath, ["fetch", "--no-tags", accepted.repositoryRoot, targetHead], signal);
    await git(mirrorPath, ["update-ref", "refs/ak-reviewer/target", targetHead], signal);
    dependencies.fault?.("mirror.verify"); await git(mirrorPath, ["cat-file", "-e", `${targetHead}^{commit}`], signal);
    return { ...accepted, targetHead, mirrorRoot, mirrorPath };
  } catch (error) { throw workspaceError(error, "snapshot", mirrorRoot === undefined ? "not-created" : { retained: mirrorRoot }, accepted); }
}
async function prepareClone(snapshot: GitSnapshot, signal: AbortSignal | undefined, dependencies: ReviewerWorkspaceDependencies): Promise<string> {
  let workspace: string | undefined; const target = { repositoryRoot: snapshot.repositoryRoot, objectFormat: snapshot.objectFormat, targetHead: snapshot.targetHead, refs: { ...snapshot.refs } };
  try {
    dependencies.fault?.("workspace.before-create"); workspace = await mkdtemp(join(tmpdir(), "ak-reviewer-leg-"));
    dependencies.fault?.("workspace.init"); await git(workspace, ["init", `--object-format=${snapshot.objectFormat}`, "--initial-branch=ak-reviewer-unborn"], signal);
    dependencies.fault?.("workspace.fetch"); await git(workspace, ["fetch", "--no-tags", snapshot.mirrorPath, snapshot.targetHead], signal);
    await git(workspace, ["checkout", "--detach", snapshot.targetHead], signal);
    dependencies.fault?.("workspace.verify"); await verifySnapshot(workspace, snapshot, signal); return workspace;
  } catch (error) { throw workspaceError(error, "workspace", workspace === undefined ? "not-created" : { retained: workspace }, target); }
}
export function createReviewerWorkspaceOwner(dependencies: ReviewerWorkspaceDependencies = {}): ReviewerWorkspaceOwner {
  let ownedSnapshot: GitSnapshot | undefined; let cleanupPromise: Promise<void> | undefined;
  return {
    async prepare(target, axes, signal) {
      const snapshot = await prepareSnapshot(target, signal, dependencies);
      ownedSnapshot = snapshot;
      const frozenTarget = Object.freeze({ repositoryRoot: snapshot.repositoryRoot, objectFormat: snapshot.objectFormat, targetHead: snapshot.targetHead, refs: Object.freeze({ ...snapshot.refs }) });
      const workspaces: ReviewerPreparedWorkspace[] = [];
      try {
        for (const axis of axes) {
          const path = await prepareClone(snapshot, signal, dependencies);
          workspaces.push(Object.freeze({ axis, path, target: frozenTarget }));
        }
      } catch (error) {
        if (typeof error === "object" && error !== null) Object.assign(error, { preparedWorkspaces: Object.freeze([...workspaces]) });
        throw error;
      }
      return Object.freeze({ target: frozenTarget, workspaces: Object.freeze(workspaces) });
    },
    async dispose(workspace) { await rm(workspace.path, { recursive: true, force: false }); return "deleted"; },
    async shutdown() {
      if (ownedSnapshot === undefined) return;
      cleanupPromise ??= rm(ownedSnapshot.mirrorRoot, { recursive: true, force: false });
      await cleanupPromise;
    },
  };
}
