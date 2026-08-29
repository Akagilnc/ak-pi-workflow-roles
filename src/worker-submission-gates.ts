/** #242/#369 worker gates ①② at submission seam. Durability: ADR 0065 createRecordSession only. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createRecordSession,
  type RecordSessionParent,
  WORKER_SUBMISSION_GATE_KIND,
} from "./archivist-record-entry.ts";
import { sitianReport } from "./sitian-facade.ts";

export const WORKER_SUBMISSION_GATE_RECORD_KIND = WORKER_SUBMISSION_GATE_KIND;
export const WORKER_COMMIT_BASELINE_ENTRY_TYPE = "commit-baseline";
export const WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE = "commit-reminder-bounce";
export const WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE = "prefix-reminder-bounce";

const DONE = new Set(["completed", "partially_completed"]);
/** Historical package hook ownership marker — uninstall criterion only. */
const HOOK_MARKER = "ak-roles: worker-submission-gates reference-transaction";
const HOOKS_DIR = "ak-roles-hooks";
const HOOK_FILE = "reference-transaction";
/** Open platform-prefix domain (constitution #10) — not a closed singleton. */
const PLATFORM_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*:/;
const UNFINISHED_REASON_BOUNCE_LIMIT = 2;

export class WorkerCommitReminderError extends Error {
  readonly code = "worker_commit_reminder" as const;
  constructor() {
    super("未观察到 commit");
    this.name = "WorkerCommitReminderError";
  }
}

export class WorkerPrefixReminderError extends Error {
  readonly code = "worker_prefix_reminder" as const;
  constructor() {
    super("观察到缺前缀 commit");
    this.name = "WorkerPrefixReminderError";
  }
}

export class WorkerUnfinishedReasonReminderError extends Error {
  readonly code = "worker_unfinished_reason_reminder" as const;
  constructor() {
    super("本次 unfinished 回执未含 reason；本接缝缺由至多打回两次。");
    this.name = "WorkerUnfinishedReasonReminderError";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unfinishedReasonPresent(details?: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim().length > 0;
}

function readGateState(session: SessionManager): {
  baseline: string | null | undefined;
  reminded: boolean;
  prefixReminded: boolean;
} {
  let baseline: string | null | undefined;
  let reminded = false;
  let prefixReminded = false;
  for (const entry of session.getEntries()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === WORKER_COMMIT_BASELINE_ENTRY_TYPE) {
      const data = entry.data;
      if (isRecord(data) && (data.head === null || typeof data.head === "string")) {
        baseline = data.head as string | null;
      }
    } else if (entry.customType === WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE) {
      reminded = true;
    } else if (entry.customType === WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE) {
      prefixReminded = true;
    }
  }
  return { baseline, reminded, prefixReminded };
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

export function createWorkerSubmissionGate(): {
  arm(cwd: string, parent?: WorkerSubmissionGateParent): void;
  assertAcceptable(status: string, details?: unknown): void;
} {
  let baseline: string | null | undefined;
  let root: string | undefined;
  let reminded = false;
  let prefixReminded = false;
  let unfinishedReasonBounces = 0;
  let record: SessionManager | undefined;
  const head = (cwd: string): string | null => {
    try {
      return git(cwd, ["rev-parse", "HEAD"]);
    } catch {
      git(cwd, ["rev-parse", "--git-dir"]); // surface real git failures
      return null;
    }
  };
  return {
    arm(cwd, parent) {
      uninstallPackageWorkerHooks(cwd);
      root = cwd;
      record = createRecordSession({
        cwd,
        kind: WORKER_SUBMISSION_GATE_RECORD_KIND,
        ...(parent === undefined ? {} : { parent }),
      });
      const prior = readGateState(record);
      if (prior.baseline !== undefined) {
        baseline = prior.baseline;
        reminded = prior.reminded;
        prefixReminded = prior.prefixReminded;
        return;
      }
      baseline = head(cwd);
      reminded = false;
      prefixReminded = false;
      record.appendCustomEntry(WORKER_COMMIT_BASELINE_ENTRY_TYPE, {
        version: 1,
        head: baseline,
      });
      sitianReport({
        level: "event",
        kind: "gate",
        cwd,
        ...(parent?.getSessionFile() ? { sessionParent: parent.getSessionFile() } : {}),
        payload: {
          type: WORKER_COMMIT_BASELINE_ENTRY_TYPE,
          version: 1,
          head: baseline,
        },
        source: "worker-submission-gates",
      });
    },
    assertAcceptable(status, details) {
      if (status === "unfinished" && !unfinishedReasonPresent(details)) {
        if (unfinishedReasonBounces < UNFINISHED_REASON_BOUNCE_LIMIT) {
          unfinishedReasonBounces += 1;
          throw new WorkerUnfinishedReasonReminderError();
        }
      }
      if (baseline === undefined || root === undefined || !DONE.has(status)) return;
      const now = head(root);
      const headMoved = now !== null && (baseline === null || now !== baseline);

      // Gate ① — forgetfulness reminder (ADR 0066; behavior unchanged).
      if (!headMoved && !reminded) {
        reminded = true;
        record?.appendCustomEntry(WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE, { version: 1 });
        sitianReport({
          level: "event",
          kind: "gate",
          cwd: root,
          payload: {
            type: WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE,
            version: 1,
          },
          source: "worker-submission-gates",
        });
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
      record?.appendCustomEntry(WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE, { version: 1 });
      sitianReport({
        level: "event",
        kind: "gate",
        cwd: root,
        payload: {
          type: WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE,
          version: 1,
        },
        source: "worker-submission-gates",
      });
      throw new WorkerPrefixReminderError();
    },
  };
}
