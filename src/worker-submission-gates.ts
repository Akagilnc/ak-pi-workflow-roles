/** #242 worker gates ①②④. ① durability: ADR 0065/#216 createRecordSession only — no appendCustomEntry bypass / parallel ledger. */
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  createRecordSession,
  type RecordSessionParent,
  WORKER_SUBMISSION_GATE_KIND,
} from "./sitian-record-entry.ts";

// ②④ install + #355 migrate live in the node/git-only module so the public CLI
// bundle can expose migrate without pulling the Pi peer graph.
export {
  installWorkerGitHooks,
  migrateWorkerGitHookScope,
} from "./worker-git-hook-scope.ts";

/** Sitian kind for gate ① durable baseline / bounce records (single path segment, not a destination). */
export const WORKER_SUBMISSION_GATE_RECORD_KIND = WORKER_SUBMISSION_GATE_KIND;
export const WORKER_COMMIT_BASELINE_ENTRY_TYPE = "commit-baseline";
export const WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE = "commit-reminder-bounce";

const DONE = new Set(["completed", "partially_completed"]);

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
