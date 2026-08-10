/** #242 worker gates ①②④. ① durability blocked on ADR 0065/#216 (no appendCustomEntry bypass). */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const WORKER_COMMIT_SUBJECT_PREFIX = "ak-roles:";
const DONE = new Set(["completed", "partially_completed"]);

export class WorkerCommitReminderError extends Error {
  readonly code = "worker_commit_reminder" as const;
  constructor() { super("未观察到 commit"); this.name = "WorkerCommitReminderError"; }
}

export const WORKER_SUBMISSION_GATE_SITIAN_DEPENDENCY = {
  issue: 216, adr: "0065",
  records: ["commit-baseline", "commit-reminder-bounce"] as const,
  status: "blocked_on_sitian_unique_entry" as const,
} as const;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

export function installWorkerGitHooks(cwd: string): void {
  const hooksPath = git(cwd, ["rev-parse", "--git-path", "hooks"]);
  const dir = isAbsolute(hooksPath) ? hooksPath : resolve(cwd, hooksPath);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "reference-transaction");
  writeFileSync(path, `#!/bin/sh
if [ "$1" != "prepared" ]; then exit 0; fi
prefix="${WORKER_COMMIT_SUBJECT_PREFIX}"
while read -r old new ref; do
  case "$ref" in refs/heads/*|HEAD) ;; *) continue ;; esac
  [ -z "$new" ] || [ -z "$(printf %s "$new" | tr -d 0)" ] && continue
  if [ -n "$old" ] && [ -n "$(printf %s "$old" | tr -d 0)" ]; then
    git merge-base --is-ancestor "$old" "$new" 2>/dev/null || { echo "ak-roles: rejected non-fast-forward update of $ref (no amend/rebase/reset)" >&2; exit 1; }
    range="$old..$new"
  else range="$new"; fi
  subjects=$(git log --format=%s "$range" 2>/dev/null) || subjects=
  [ -z "$subjects" ] && continue
  old_ifs=$IFS; IFS="
"
  for subj in $subjects; do
    IFS=$old_ifs; [ -z "$subj" ] && continue
    case "$subj" in "$prefix"*) ;; *) echo "ak-roles: commit subject must start with $prefix (got: $subj)" >&2; exit 1 ;; esac
  done
  IFS=$old_ifs
done
exit 0
`, "utf8");
  chmodSync(path, 0o755);
}

export function createWorkerSubmissionGate(): { arm(cwd: string): void; assertAcceptable(status: string): void } {
  let baseline: string | null | undefined;
  let root: string | undefined;
  let reminded = false;
  const head = (cwd: string) => { try { return git(cwd, ["rev-parse", "HEAD"]); } catch { return null; } };
  return {
    arm(cwd: string) { root = cwd; baseline = head(cwd); reminded = false; },
    assertAcceptable(status: string) {
      if (baseline === undefined || root === undefined || !DONE.has(status)) return;
      const now = head(root);
      if ((now !== null && (baseline === null || now !== baseline)) || reminded) { reminded = true; return; }
      reminded = true;
      throw new WorkerCommitReminderError();
    },
  };
}
