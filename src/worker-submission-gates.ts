/** #242/#369 worker gates ①② at submission seam. Durability: ADR 0065 createRecordSession only. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createRecordSession,
  type RecordSessionParent,
  WORKER_SUBMISSION_GATE_KIND,
} from "./sitian-record-entry.ts";

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
    super("观察到缺前缀 commit，请重写后再交");
    this.name = "WorkerPrefixReminderError";
  }
}

export class WorkerUnfinishedReasonReminderError extends Error {
  readonly code = "worker_unfinished_reason_reminder" as const;
  constructor() {
    super("补理由（前置缺失/违宪之一）或继续施工");
    this.name = "WorkerUnfinishedReasonReminderError";
  }
}

export type WorkerSubmissionGateParent = RecordSessionParent;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

function gitFile(file: string, args: string[]): string {
  return execFileSync("git", ["config", "--file", file, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
  }).trim();
}

function statusOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status: unknown }).status
    : undefined;
}

function tryGet(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return gitFile(file, ["--get", key]);
  } catch (error) {
    if (statusOf(error) !== 1) throw error;
    return undefined;
  }
}

function ownedHook(path: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, "utf8").includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

function ownedDir(dir: string): boolean {
  return ownedHook(resolve(dir, HOOK_FILE));
}

function unsetOwnedHooksPath(file: string): string | undefined {
  const value = tryGet(file, "core.hooksPath");
  if (value === undefined || !ownedDir(value)) return undefined;
  try {
    gitFile(file, ["--unset", "core.hooksPath"]);
  } catch (error) {
    if (statusOf(error) !== 5) throw error; // 5 = already absent
  }
  return value;
}

function rmOwnedDir(dir: string): void {
  if (!ownedDir(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function rmOwnedLegacyHook(commonDir: string): void {
  const path = resolve(commonDir, "hooks", HOOK_FILE);
  if (!ownedHook(path)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

function linkedGitDirs(commonDir: string): string[] {
  const root = resolve(commonDir, "worktrees");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = resolve(root, name);
    try {
      if (statSync(dir).isDirectory()) out.push(dir);
    } catch {
      /* raced */
    }
  }
  return out;
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
  // Unset every owned hooksPath first, then remove dirs — never delete the marker
  // file while a config entry still points at it (ownership check would then fail).
  const clear = (configFile: string): void => {
    const hooks = unsetOwnedHooksPath(configFile);
    if (hooks !== undefined) rmOwnedDir(hooks);
  };
  clear(resolve(commonDir, "config"));
  clear(resolve(commonDir, "config.worktree"));
  rmOwnedDir(resolve(commonDir, HOOKS_DIR));
  rmOwnedLegacyHook(commonDir);
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
  try {
    const reason = (details as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim().length > 0;
  } catch {
    return false;
  }
}

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
    const parents = line.slice(0, sep).trim();
    return [{ subject: line.slice(sep + 1), merge: parents.includes(" ") }];
  });
}

function hasMissingPrefix(
  commits: ReadonlyArray<{ subject: string; merge: boolean }>,
): boolean {
  return commits.some((c) => !c.merge && !PLATFORM_PREFIX.test(c.subject));
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
      record = openGateRecord(cwd, parent);
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
        throw new WorkerCommitReminderError();
      }
      reminded = true;

      // Gate ② — open platform-prefix soft reminder (ADR 0070).
      if (prefixReminded || now === null) return;
      const window = reliableWindow(root, baseline, now);
      if (window === null || window.length === 0 || !hasMissingPrefix(window)) return;
      prefixReminded = true;
      record?.appendCustomEntry(WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE, { version: 1 });
      throw new WorkerPrefixReminderError();
    },
  };
}
