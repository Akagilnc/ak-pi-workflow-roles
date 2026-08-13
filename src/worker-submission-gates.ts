/** #242 worker gates ①②④. ① durability: ADR 0065/#216 createRecordSession only — no appendCustomEntry bypass / parallel ledger. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createRecordSession,
  type RecordSessionParent,
  WORKER_SUBMISSION_GATE_KIND,
} from "./sitian-record-entry.ts";

export const WORKER_COMMIT_SUBJECT_PREFIX = "ak-roles:";
/** Sitian kind for gate ① durable baseline / bounce records (single path segment, not a destination). */
export const WORKER_SUBMISSION_GATE_RECORD_KIND = WORKER_SUBMISSION_GATE_KIND;
export const WORKER_COMMIT_BASELINE_ENTRY_TYPE = "commit-baseline";
export const WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE = "commit-reminder-bounce";

const DONE = new Set(["completed", "partially_completed"]);
/** Marker: own-package hooks are reloadable across HOOK body changes; foreign hooks refuse. */
const HOOK_MARKER = "ak-roles: worker-submission-gates reference-transaction";

export class WorkerCommitReminderError extends Error {
  readonly code = "worker_commit_reminder" as const;
  constructor() { super("未观察到 commit"); this.name = "WorkerCommitReminderError"; }
}

/** #292 unfinished reason solicitation — same bounce shape as gate ①; in-session only. */
export class WorkerUnfinishedReasonReminderError extends Error {
  readonly code = "worker_unfinished_reason_reminder" as const;
  constructor() {
    super("补理由（前置缺失/违宪之一）或继续施工");
    this.name = "WorkerUnfinishedReasonReminderError";
  }
}

const UNFINISHED_REASON_BOUNCE_LIMIT = 2;

function unfinishedReasonPresent(details?: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  try {
    const reason = (details as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim().length > 0;
  } catch {
    return false;
  }
}

export type WorkerSubmissionGateParent = RecordSessionParent;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

function gitFile(file: string, args: string[]): string {
  return execFileSync("git", ["config", "--file", file, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

// ② each newly-created commit (incl. empty subject); ④ ban non-fast-forward.
// Scoped by install: worktree-local core.hooksPath → only the armed tree.
const HOOK = `#!/bin/sh
# ${HOOK_MARKER}
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

/**
 * Bind ②④ to this worktree only — private hooksPath + worktree config.
 * Never leave shared common config in a state that bricks sibling/main trees
 * (git requires core.bare/core.worktree moved out of common when worktreeConfig is on).
 */
export function installWorkerGitHooks(cwd: string): void {
  // Fail closed before any shared-config write: bare host / non-work-tree is not armable.
  let inside: string;
  try {
    inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    throw new Error(
      `ak-roles: refusing worker hooks install outside a git work tree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (inside !== "true") {
    throw new Error("ak-roles: refusing worker hooks install outside a git work tree");
  }

  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonConfig = resolve(commonDir, "config");
  const mainWorktreeConfig = resolve(commonDir, "config.worktree");

  // Snapshot worktree-only keys still sitting in common config (git docs: must move on enable).
  let bareInCommon = false;
  let worktreeInCommon: string | undefined;
  try { bareInCommon = gitFile(commonConfig, ["--get", "core.bare"]) === "true"; } catch { /* unset */ }
  try { worktreeInCommon = gitFile(commonConfig, ["--get", "core.worktree"]); } catch { /* unset */ }

  // Skip shared write when already enabled in *this* repo — concurrent sibling activations
  // otherwise race on .git/config.lock (#267). Scope must be --local (common config): a
  // global/system true must not skip the repo's first enable. Value must use Git bool
  // semantics (true/yes/on/1), not a literal "true" compare. First enable still writes;
  // real write failures still throw. Only --get exit 1 means unset; other failures stay loud.
  let worktreeConfigEnabled = false;
  try {
    worktreeConfigEnabled =
      git(cwd, ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"]) === "true";
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status: unknown }).status
        : undefined;
    if (status !== 1) throw error;
  }
  if (!worktreeConfigEnabled) {
    git(cwd, ["config", "extensions.worktreeConfig", "true"]);
  }

  // Migrate immediately so sibling trees never observe bare-in-common under worktreeConfig.
  if (bareInCommon) {
    try { gitFile(commonConfig, ["--unset", "core.bare"]); } catch { /* raced */ }
    gitFile(mainWorktreeConfig, ["core.bare", "true"]);
  }
  if (worktreeInCommon !== undefined) {
    try { gitFile(commonConfig, ["--unset", "core.worktree"]); } catch { /* raced */ }
    gitFile(mainWorktreeConfig, ["core.worktree", worktreeInCommon]);
  }

  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const dir = resolve(gitDir, "ak-roles-hooks");
  const path = resolve(dir, "reference-transaction");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    // Own-package marker → reload OK (HOOK body may change across versions).
    // Foreign same-name hook → fail closed, never overwrite.
    if (!existing.includes(HOOK_MARKER)) {
      throw new Error("ak-roles: refusing to overwrite existing reference-transaction hook");
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, HOOK, "utf8");
  chmodSync(path, 0o755);
  git(cwd, ["config", "--worktree", "core.hooksPath", dir]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Open gate ① record via sitian entry only — resume/lifecycle live in createRecordSession.
 * Gate consumes the returned session; no nest scan, unlink, or peer reopen.
 */
function openGateRecord(cwd: string, parent?: WorkerSubmissionGateParent): SessionManager {
  return createRecordSession({
    cwd,
    kind: WORKER_SUBMISSION_GATE_RECORD_KIND,
    ...(parent === undefined ? {} : { parent }),
  });
}

function readGateState(session: SessionManager): {
  baseline: string | null | undefined;
  reminded: boolean;
} {
  let baseline: string | null | undefined;
  let reminded = false;
  for (const entry of session.getEntries()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === WORKER_COMMIT_BASELINE_ENTRY_TYPE) {
      const data = entry.data;
      if (isRecord(data) && (data.head === null || typeof data.head === "string")) {
        baseline = data.head as string | null;
      }
    } else if (entry.customType === WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE) {
      reminded = true;
    }
  }
  return { baseline, reminded };
}

export function createWorkerSubmissionGate(): {
  arm(cwd: string, parent?: WorkerSubmissionGateParent): void;
  assertAcceptable(status: string, details?: unknown): void;
} {
  let baseline: string | null | undefined;
  let root: string | undefined;
  let reminded = false;
  let unfinishedReasonBounces = 0;
  let record: SessionManager | undefined;
  // null = unborn HEAD only; any other git failure throws (no swallow).
  const head = (cwd: string): string | null => {
    try { return git(cwd, ["rev-parse", "HEAD"]); }
    catch {
      git(cwd, ["rev-parse", "--git-dir"]); // surface real git/repo failures
      return null;
    }
  };
  return {
    arm(cwd, parent) {
      root = cwd;
      record = openGateRecord(cwd, parent);
      const prior = readGateState(record);
      if (prior.baseline !== undefined) {
        // Cross-resume: keep first-arm baseline and any prior bounce (no second false bounce).
        baseline = prior.baseline;
        reminded = prior.reminded;
        return;
      }
      baseline = head(cwd);
      reminded = false;
      // First arm writes baseline through the sitian-created session (auditor pattern).
      record.appendCustomEntry(WORKER_COMMIT_BASELINE_ENTRY_TYPE, {
        version: 1,
        head: baseline,
      });
    },
    assertAcceptable(status, details) {
      // #292: unfinished without a non-blank reason → in-session bounce (max 2), then accept.
      if (status === "unfinished" && !unfinishedReasonPresent(details)) {
        if (unfinishedReasonBounces < UNFINISHED_REASON_BOUNCE_LIMIT) {
          unfinishedReasonBounces += 1;
          throw new WorkerUnfinishedReasonReminderError();
        }
      }
      if (baseline === undefined || root === undefined || !DONE.has(status)) return;
      const now = head(root);
      if ((now !== null && (baseline === null || now !== baseline)) || reminded) {
        reminded = true;
        return;
      }
      reminded = true;
      // Durable bounce once per run — resume must not re-fire the same reminder.
      record?.appendCustomEntry(WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE, { version: 1 });
      throw new WorkerCommitReminderError();
    },
  };
}
