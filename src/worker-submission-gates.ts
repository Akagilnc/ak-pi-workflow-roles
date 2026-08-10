/** #242 worker gates ①②④. ① durability: ADR 0065/#216 only — no appendCustomEntry bypass. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const WORKER_COMMIT_SUBJECT_PREFIX = "ak-roles:";
const DONE = new Set(["completed", "partially_completed"]);

export class WorkerCommitReminderError extends Error {
  readonly code = "worker_commit_reminder" as const;
  constructor() { super("未观察到 commit"); this.name = "WorkerCommitReminderError"; }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

// ② each newly-created commit (incl. empty subject); ④ ban non-fast-forward.
// Scoped by install: worktree-local core.hooksPath → only the armed tree.
const HOOK = `#!/bin/sh
[ "$1" = prepared ] || exit 0
prefix=${WORKER_COMMIT_SUBJECT_PREFIX}
while read -r old new ref; do
  case $ref in refs/heads/*|HEAD) ;; *) continue ;; esac
  [ -n "$new" ] && [ -n "$(printf %s "$new" | tr -d 0)" ] || continue
  if [ -n "$old" ] && [ -n "$(printf %s "$old" | tr -d 0)" ]; then
    git merge-base --is-ancestor "$old" "$new" 2>/dev/null || { echo "ak-roles: rejected non-fast-forward update of $ref (no amend/rebase/reset)" >&2; exit 1; }
  fi
  for commit in $(git rev-list "$new" --not --all 2>/dev/null); do
    subj=$(git log -1 --format=%s "$commit")
    case $subj in "$prefix"*) ;; *) echo "ak-roles: commit subject must start with $prefix (got: $subj)" >&2; exit 1 ;; esac
  done
done
`;

/** Bind ②④ to this worktree only — private hooksPath + worktree config; never shared common hooks. */
export function installWorkerGitHooks(cwd: string): void {
  git(cwd, ["config", "extensions.worktreeConfig", "true"]);
  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const dir = resolve(gitDir, "ak-roles-hooks");
  const path = resolve(dir, "reference-transaction");
  if (existsSync(path) && readFileSync(path, "utf8") !== HOOK) {
    throw new Error("ak-roles: refusing to overwrite existing reference-transaction hook");
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, HOOK, "utf8");
  chmodSync(path, 0o755);
  git(cwd, ["config", "--worktree", "core.hooksPath", dir]);
}

export function createWorkerSubmissionGate(): { arm(cwd: string): void; assertAcceptable(status: string): void } {
  let baseline: string | null | undefined, root: string | undefined, reminded = false;
  // null = unborn HEAD only; any other git failure throws (no swallow).
  const head = (cwd: string): string | null => {
    try { return git(cwd, ["rev-parse", "HEAD"]); }
    catch {
      git(cwd, ["rev-parse", "--git-dir"]); // surface real git/repo failures
      return null;
    }
  };
  return {
    arm(cwd) { root = cwd; baseline = head(cwd); reminded = false; },
    assertAcceptable(status) {
      if (baseline === undefined || root === undefined || !DONE.has(status)) return;
      const now = head(root);
      if ((now !== null && (baseline === null || now !== baseline)) || reminded) { reminded = true; return; }
      reminded = true;
      throw new WorkerCommitReminderError();
    },
  };
}
