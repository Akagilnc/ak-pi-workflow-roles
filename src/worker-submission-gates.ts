/** #242/#369 worker gates ①② at submission seam.
 * Durability (#1178): this leg's state.jsonl via reportRunRecord / readStateRowsSync.
 * No session/worker-submission-gate/ side-branch nest.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { runDirectoryOfSessionFile } from "./role-run-placement.ts";
import { readStateRowsSync } from "./run-dossier.ts";
import { reportRunRecord } from "./sitian-facade.ts";
import {
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
} from "./submission-errors.ts";
import { WORKER_DONE_STATUSES } from "./worker-submission-contracts.ts";
import { deliveryLimitFromConfig } from "./receipt-delivery-policy.ts";

import { isRecord } from "./unknown-value.ts";

export { WorkerCommitReminderError, WorkerPrefixReminderError, WorkerUnfinishedReasonReminderError } from "./submission-errors.ts";
export { WORKER_DONE_STATUSES } from "./worker-submission-contracts.ts";

/** Historical kind name — no longer a nest identity; kept for callers/tests that still name the gate. */
export const WORKER_SUBMISSION_GATE_RECORD_KIND = "worker-submission-gate";
export const WORKER_COMMIT_BASELINE_ENTRY_TYPE = "commit-baseline";
export const WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE = "commit-reminder-bounce";
export const WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE = "prefix-reminder-bounce";
export const WORKER_UNFINISHED_REASON_BOUNCE_ENTRY_TYPE = "unfinished-reason-bounce";

/** Historical package hook ownership marker — uninstall criterion only. */
const HOOK_MARKER = "ak-roles: worker-submission-gates reference-transaction";
const HOOKS_DIR = "ak-roles-hooks";
const HOOK_FILE = "reference-transaction";
/** Open platform-prefix domain (constitution #10) — not a closed singleton. */
const PLATFORM_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*:/;

const GATE_SOURCE = "worker-submission-gates";

/** Live parent session — mid-turn report-ticket updates setSessionFile (#1171). */
export type WorkerSubmissionGateParent = {
  getSessionFile(): string | undefined;
};

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

function statusOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status: unknown }).status
    : undefined;
}

function tryGetAll(file: string, key: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const out = gitFile(file, ["--get-all", key]);
    return out.length === 0 ? [] : out.split("\n");
  } catch (error) {
    // --get-all exit 1 = absent; other failures stay loud.
    if (statusOf(error) !== 1) throw error;
    return [];
  }
}

/** True only when the file exists and carries the historical package marker.
 *  Read failures propagate — never disguised as "not owned". */
function ownedHook(path: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(HOOK_MARKER);
}

/** Escape a hooksPath value for git config --unset value-pattern (POSIX ERE). */
function escapeGitConfigValueRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Remove only package-owned core.hooksPath values; keep every foreign value.
 * --unset without a value-pattern exits 5 for both "absent" and "multi-value",
 * so multi-valued keys must be addressed per matching value.
 */
function unsetOwnedHooksPath(file: string): string[] {
  const owned: string[] = [];
  for (const value of tryGetAll(file, "core.hooksPath")) {
    if (!ownedHook(resolve(value, HOOK_FILE))) continue;
    try {
      // --unset-all + exact value-pattern drops every duplicate owned copy; foreign stays.
      gitFile(file, [
        "--unset-all",
        "core.hooksPath",
        `^${escapeGitConfigValueRegex(value)}$`,
      ]);
    } catch (error) {
      // 5 = this specific value already absent (not multi-value ambiguity).
      if (statusOf(error) !== 5) throw error;
    }
    owned.push(value);
  }
  return owned;
}

/** Delete only the package-owned hook file; rmdir solely when empty. */
function rmOwnedDir(dir: string): void {
  const hookPath = resolve(dir, HOOK_FILE);
  if (!ownedHook(hookPath)) return;
  rmSync(hookPath, { force: true });
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

function linkedGitDirs(commonDir: string): string[] {
  const root = resolve(commonDir, "worktrees");
  if (!existsSync(root)) return [];
  // Enumeration/lstat failures propagate — never skip a linked admin dir silently.
  // lstat does not follow: symlink entries are not directories and stay out of range.
  return readdirSync(root)
    .map((name) => resolve(root, name))
    .filter((dir) => lstatSync(dir).isDirectory());
}

/**
 * ADR 0070 §4 — private one-shot uninstall on arm.
 * Range: current repo + enumerable worktree admin dirs. Owned hooksPath/files only.
 * Never rolls back extensions.worktreeConfig / migrated bare|worktree / foreign hooksPath.
 */
function uninstallPackageWorkerHooks(cwd: string): void {
  let inside: string;
  try {
    inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return;
  }
  if (inside !== "true") return;

  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // Unset owned hooksPath before deleting the marker file (ownership check needs it).
  const clear = (configFile: string): void => {
    for (const hooks of unsetOwnedHooksPath(configFile)) rmOwnedDir(hooks);
  };
  clear(resolve(commonDir, "config"));
  clear(resolve(commonDir, "config.worktree"));
  rmOwnedDir(resolve(commonDir, HOOKS_DIR));
  const legacy = resolve(commonDir, "hooks", HOOK_FILE);
  if (ownedHook(legacy)) rmSync(legacy, { force: true });
  for (const gitDir of linkedGitDirs(commonDir)) {
    clear(resolve(gitDir, "config.worktree"));
    rmOwnedDir(resolve(gitDir, HOOKS_DIR));
  }
}

/** ADR 0050: a written explanation, including text carried by an object key. */
function containsWrittenReason(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(containsWrittenReason);
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) => containsWrittenReason(key) || containsWrittenReason(item),
    );
  }
  return false;
}

function unfinishedReasonPresent(details?: unknown): boolean {
  if (!isRecord(details)) return false;
  return containsWrittenReason(details.reason);
}

function liveRunDirectory(parent: WorkerSubmissionGateParent): string {
  const file = parent.getSessionFile();
  if (file === undefined || file.length === 0) {
    throw new Error("Worker submission gate requires a parent session file for this leg's state.jsonl");
  }
  return runDirectoryOfSessionFile(file);
}

function readGateState(runDirectory: string, invocationScopeId?: string): {
  baseline: string | null | undefined;
  reminded: boolean;
  prefixReminded: boolean;
  unfinishedReasonBounces: number;
} {
  // Fail closed on unreadable state — same contract as other state.jsonl control paths.
  const rows = readStateRowsSync(runDirectory);
  let baseline: string | null | undefined;
  let reminded = false;
  let prefixReminded = false;
  let unfinishedReasonBounces = 0;
  for (const row of rows) {
    const kind = row.kind;
    const payload = row.payload;
    if (kind === WORKER_COMMIT_BASELINE_ENTRY_TYPE) {
      if (isRecord(payload) && (payload.head === null || typeof payload.head === "string")) {
        baseline = payload.head as string | null;
      }
    } else if (kind === WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE) {
      reminded = true;
    } else if (kind === WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE) {
      prefixReminded = true;
    } else if (
      kind === WORKER_UNFINISHED_REASON_BOUNCE_ENTRY_TYPE
      && invocationScopeId !== undefined
      && isRecord(payload)
      && payload.invocationScopeId === invocationScopeId
    ) {
      unfinishedReasonBounces += 1;
    }
  }
  return { baseline, reminded, prefixReminded, unfinishedReasonBounces };
}

function appendGateState(
  runDirectory: string,
  kind: string,
  payload: Record<string, unknown>,
): void {
  reportRunRecord(runDirectory, kind, payload, GATE_SOURCE);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (statusOf(error) === 1) return false;
    throw error;
  }
}

/**
 * Reliable window (ADR 0070). null = unreliable tip-SHA baseline; [] = empty.
 * Structured git-log fields only — never parse a shell command string.
 */
function reliableWindow(
  cwd: string,
  baseline: string | null,
  head: string,
): ReadonlyArray<{ subject: string; merge: boolean }> | null {
  if (baseline !== null && !isAncestor(cwd, baseline, head)) return null;
  const range = baseline === null ? head : `${baseline}..${head}`;
  const raw = git(cwd, ["log", "--format=%P%x1e%s", range]);
  if (raw.length === 0) return [];
  return raw.split("\n").flatMap((line) => {
    const sep = line.indexOf("\x1e");
    if (sep < 0) return [];
    return [{
      subject: line.slice(sep + 1),
      merge: line.slice(0, sep).trim().includes(" "),
    }];
  });
}

export type CreateWorkerSubmissionGateOptions = {
  /**
   * #1132: ADR 0050 缺理由催全次数 read from the single configured
   * `autoResumeLimit` value. Absent = package default. Resolved once here; the
   * gate never re-reads it per submission. Exhaustion still accepts (照收) —
   * only the count changes.
   */
  readonly unfinishedReasonBounceLimit?: number;
};

export function createWorkerSubmissionGate(
  options: CreateWorkerSubmissionGateOptions = {},
): {
  /** Durable parent is required — ownership must be known at arm (#857 loud failure). */
  arm(cwd: string, parent: WorkerSubmissionGateParent, invocationScopeId?: string): void;
  assertAcceptable(status: string, details?: unknown): void;
} {
  let baseline: string | null | undefined;
  let root: string | undefined;
  let reminded = false;
  let prefixReminded = false;
  let unfinishedReasonBounces = 0;
  let invocationScopeId: string | undefined;
  /** Live parent — mid-turn report-ticket renames the run leaf and updates setSessionFile. */
  let parentRef: WorkerSubmissionGateParent | undefined;
  // #1132: one configured number, resolved once at gate construction.
  const unfinishedReasonBounceLimit = deliveryLimitFromConfig(options.unfinishedReasonBounceLimit);
  const head = (cwd: string): string | null => {
    try {
      return git(cwd, ["rev-parse", "HEAD"]);
    } catch {
      git(cwd, ["rev-parse", "--git-dir"]); // surface real git failures
      return null;
    }
  };
  /** Current leg directory from the live parent session file. */
  const liveDir = (): string => {
    if (parentRef === undefined) {
      throw new Error("Worker submission gate is not armed");
    }
    return liveRunDirectory(parentRef);
  };
  return {
    arm(cwd, parent, scope) {
      invocationScopeId = scope;
      uninstallPackageWorkerHooks(cwd);
      root = cwd;
      parentRef = parent;
      const runDirectory = liveRunDirectory(parent);
      const prior = readGateState(runDirectory, invocationScopeId);
      unfinishedReasonBounces = prior.unfinishedReasonBounces;
      if (prior.baseline !== undefined) {
        baseline = prior.baseline;
        reminded = prior.reminded;
        prefixReminded = prior.prefixReminded;
        return;
      }
      baseline = head(cwd);
      reminded = false;
      prefixReminded = false;
      appendGateState(runDirectory, WORKER_COMMIT_BASELINE_ENTRY_TYPE, {
        version: 1,
        head: baseline,
      });
    },
    assertAcceptable(status, details) {
      if (status === "unfinished" && !unfinishedReasonPresent(details)) {
        if (unfinishedReasonBounces < unfinishedReasonBounceLimit) {
          if (parentRef !== undefined) {
            appendGateState(liveDir(), WORKER_UNFINISHED_REASON_BOUNCE_ENTRY_TYPE, {
              version: 1,
              invocationScopeId,
            });
          }
          unfinishedReasonBounces += 1;
          throw new WorkerUnfinishedReasonReminderError();
        }
      }
      if (baseline === undefined || root === undefined || !WORKER_DONE_STATUSES.has(status)) return;
      const now = head(root);
      const headMoved = now !== null && (baseline === null || now !== baseline);

      // Gate ① — forgetfulness reminder (ADR 0066; behavior unchanged).
      if (!headMoved && !reminded) {
        reminded = true;
        appendGateState(liveDir(), WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE, { version: 1 });
        throw new WorkerCommitReminderError();
      }
      reminded = true;

      // Gate ② — open platform-prefix soft reminder (ADR 0070).
      if (prefixReminded || now === null) return;
      const window = reliableWindow(root, baseline, now);
      if (
        window === null ||
        window.length === 0 ||
        !window.some((c) => !c.merge && !PLATFORM_PREFIX.test(c.subject))
      ) {
        return;
      }
      prefixReminded = true;
      appendGateState(liveDir(), WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE, { version: 1 });
      throw new WorkerPrefixReminderError();
    },
  };
}

/** The gate object returned above. Callers reference this instead of restating assertAcceptable. */
export type WorkerSubmissionGate = ReturnType<typeof createWorkerSubmissionGate>;
